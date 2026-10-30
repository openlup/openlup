# Contributing to OpenLup

OpenLup is in development preview. Contributions are welcome, but a source
checkout is not yet a stable framework release, a supported installation, or an
upgrade contract. The later stable-framework gate owns those commitments.

Start with the [platform documentation](docs/platform/README.md), then read the
[public agent guide](docs/platform/AGENT_GUIDE.md) before changing a platform
boundary. The [governance policy](.github/GOVERNANCE.md) owns contribution
admission, compatibility ownership, and maintainer capacity; accepting a pull
request does not automatically promote its subject to an official module.

For documentation changes, use the short [public writing profile and page
template](docs/platform/README.md#write-or-update-a-page). State which reader
and current preview it serves, verify commands from the stated working directory,
and separate current behavior from proposals or dated history. Correct the
owning page in the same contribution as a changed public contract; a link check
alone does not establish that an install or feature works.

## Use a package or contribute source

For an application task, start from your application's root with Node 24 and
npm 11.19.0: `npm install --save-exact @openlup/core@<version>`, where `<version>`
is the current set on npm (`npm view @openlup/core version`); install every
`@openlup/*` package you use at that same version. Read the installed
`AGENTS.md` and its [typed wiring example](packages/core/AGENTS.md#wiring-example),
then use the [adopter route](docs/platform/adopter-kit/README.md). No OpenLup
clone or contributor check is needed to compose an installed package. Your
application's instructions and task authority govern that work.

The remaining commands in this guide require an OpenLup source checkout.

## Contribution shape

Before planning a module or npm name, follow the canonical
[package placement decision](docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#package-placement-decision-canonical).

Before implementing, obtain the accountable human's task scope and the applicable
maintainer authorization under the [AI contribution policy](.github/AI_CONTRIBUTION_POLICY.md).
Record whether it covers only local work or also publication, pull-request
submission and merge. Review evidence cannot extend those rights.

A new explicitly approved bounded module programme may include implementation
and set-version preparation in one pull request under
[package release policy](.github/VERSIONING_AND_EOL.md#package-releases).
Delivery or merge delegation applies only when the applicable maintainer-local
policy and that programme explicitly grant it; this guide does not activate it
or extend existing tasks. The [agent guide](AGENTS.md#change-and-verification-rules)
owns freshness, required maintainer reads and the retained authority boundaries.

Use a dedicated task worktree and branch for implementation; the coordination
checkout stays clean. Claude and Codex create that isolation automatically with
the configured repository helper before task edits, installs or tests. Continue
in an already assigned task worktree and leave other tasks' checkouts alone.

If no maintainer helper is configured, use ordinary Git isolation. In a local
fork, `origin` normally names your fork: add `upstream` for
`https://github.com/openlup/openlup.git` if needed. From the coordination checkout,
the following example uses a new task name `my-change`:

```sh
git fetch upstream main
OPENLUP_BASE="$(git rev-parse upstream/main)"
git worktree add -b codex/my-change ../openlup-my-change "$OPENLUP_BASE"
cd ../openlup-my-change
```

Retain that full base SHA in the task record, then install and run the public
checks in this task worktree. A maintainer helper, native review access and
upstream write rights are not prerequisites for preparing a local contribution.

Record the finite observable outcome, smallest complete scope and exclusions,
authority and delivery boundary, acceptance and sufficient completion evidence,
risk and execution/proof plan compactly. Plans and handoffs inherit these boundaries
under the [agent guide](docs/platform/AGENT_GUIDE.md#change-and-verification-rules);
discoveries do not automatically add obligations. Small tasks need no separate
planning ceremony or specification.
Consider removing the cause or reusing an existing seam before adding a new
abstraction; explain a concrete benefit over a simpler alternative when needed.
Keep the accepted goal and guarantees fixed while execution notes evolve.
The [AI contribution policy](.github/AI_CONTRIBUTION_POLICY.md) owns accountability,
DCO, publication authority and independent native-session review.

Keep a change focused and explain its public contract, compatibility boundary,
and test evidence. Add or update tests for the behaviour you change. Provider
and runtime integrations must use documented ports and demonstrate both their
declared capability and their refusal behaviour without live provider access.

Do not include sensitive values, customer data, or deployment-specific details
in commits, issue reports, test fixtures, screenshots, or logs. Follow
[SECURITY.md](SECURITY.md) for responsible disclosure and sensitive-material
handling.

### Instruction freshness and handoffs

At task start, resume after compaction, and handoff, recover the approved scope,
open findings, failed attempts and consumed budgets from the existing task record.
Check the applicable instructions against a freshly fetched policy revision and
retain its full main commit in that record, separately from the code review base.
At the next boundary, compare the relevant instruction paths since that pin and
read their changed owners; do not fetch before every command. Offline, retain the
last verified pin and identify freshness as unverified. New task isolation follows
the approved base or stack dependency; an active branch needs no rebase, reset or
main merge solely to read current instructions. If a required tool is absent on
that code base, report the incompatibility rather than simulate its check.

Project memory and handoff notes link to canonical instructions instead of
maintaining competing rule copies; preserve useful lessons and existing evidence.
Keep backups outside automatically loaded memory. Verify what the actual agent
host loads, including relevant local or parent instructions: a file's presence in
context does not prove the correct policy revision was read. A tool-specific
import or existing start/compaction hook may restore a short task/pin reminder;
avoid another full rule copy. A template is not proof of installation, and a
loaded instruction is not enforced configuration. Host settings and memory edits
still require their actual scope; this procedure installs no hook or global rule.

### Contribute existing adopter code, then refactor

Code that already runs in an adopter's application reaches OpenLup in a fixed
order, so that the adopter can later replace its own copy without any change
its users or operators can observe.

1. **Characterize first.** Before contributing, the adopter writes tests in its
   own repository that pin the slice's current behaviour: results, errors and
   refusals. Rewritten with neutral names and synthetic data, they become the
   witness.
2. **Import with unchanged logic.** The first OpenLup pull request brings the
   slice with its logic unchanged, written fresh in the OpenLup worktree with
   neutral names, literals, copy and identifiers from the start; adopter files,
   history, tests and fixtures are never copied, and the neutrality rules apply
   from the first commit. Private values, customer data and deployment details
   never enter a commit.
   The witness lands in the same pull request as package tests, and the
   package's tests join the required test selection, so required CI runs them
   while the package is still unreleased. As with `packages/outbox`, extend the
   root Vitest configuration so `npm test` discovers the new package tests;
   the four hosted shards feed the required `test` aggregate.
3. **Refactor in later pull requests.** Each refactoring pull request keeps the
   witness unchanged. A refactor changes nothing a consumer can observe:
   results, side effects, ordering, errors and fault modes, operational logs,
   defaults, load order, policy, schema and SQL object names, configuration
   names, URLs, cron paths and persisted keys. A performance change qualifies only with identical
   observable results. Anything else is a behaviour change: propose and review
   it as one, with its own changelog entry, never inside a refactoring pull
   request.
4. **Check before release.** Before the release dispatch, the contributor packs
   the release candidate and gives the adopter its commit and tarball checksums;
   the adopter installs those tarballs without committing them and runs its
   characterization against them. A difference is fixed in OpenLup before
   publication.
5. **Adopt thinly.** The adopter replaces its copy by changing imports and
   adapter bindings only. It keeps its own persisted names and maps the
   package's neutral names in its adapter.

## Development-preview checks

The opt-in [local self-host recipe](docs/platform/RUNTIME_AND_SELF_HOSTING.md#recipe-conformance-runner)
calls the existing installation, schema, catch-up and older-snapshot witnesses,
then real issuer, local gateway and Node/OCI fixture compositions. Its plain-Node
storage proof body is shared with the ordinary S3 conformance test; the public
execution inventory includes that body and the bundled synthetic host actor.
The focused recipe input/disposition tests run with
`npm test -- tests/postgres/m14RecipeConformance.test.ts`; a COMPLETE local
receipt additionally requires the destructive opt-in command and all its
prerequisites. Neither focused tests nor a local receipt establish hosted
qualification, and the three operator-declared database targets need their
separate operator teardown.

The [market descriptor proof](scripts/packages/market-descriptor-consumer-proof.ts)
joins the existing installed platform cold-consumer selection.

The installed `openlup-context` command uses the tracked core
[launcher](packages/core/src/openlup-context.js) and compiled
retrieval code. The public execution catalogue binds that exact executable
inventory and its package scripts/bin digest; the launcher does not admit
additional executable paths. This offline command adds no runtime dependency,
package or service. `npm run oss:published-tree -- --policy` also checks that
the committed agent excerpts still match their canonical owner sections.
Changes to its executable surface, publication controls or
package gate budgets require the applicable maintainer read before sign-off;
passing the inventory check does not establish that read or authorize release.

The opt-in [recipe conformance runner](tests/postgres/runM14RecipeConformance.mjs)
uses the existing restricted-install and released-schema proofs with three
explicitly disposable external PG16 targets. Its private-file/target/refusal
regressions run with `npm test -- tests/postgres/m14RecipeConformance.test.ts`.
The [runtime owner](docs/platform/RUNTIME_AND_SELF_HOSTING.md#recipe-conformance-runner)
defines input, TLS, mutation and pending-receipt limits. Its execution entry is
part of the ordinary closed public command inventory; it adds no default hosted
or destructive CI target.

The existing policy/self-check also validates ordinary local Markdown file links
and fragments, beyond mapped owner anchors. Source ownership is narrowed by
module/contract section so an unrelated README edit does not settle an affected
contract. The [documentation maintenance rules](docs/platform/DOCUMENTATION.md#impact)
define scoped no-impact answers and review of related examples. New native
reports include the short documentation assessment described under
[native review](#native-review-and-accountability); prior recorded reports retain
their history and expiry. These checks add no job, reviewer floor or gate budget.

The [migration-session witness](tests/postgres/m14MigrationSessionAdmission.test.ts)
uses the production package runner to check ledger admission, stable reads,
write admission, complete inventory projection and compatibility for status,
dry-run and apply.
It covers a single-deviation catalog-shape matrix, temporary name shadowing,
and bootstrap-owned ledger reads from a distinct
migration login. Run it with
`npm test -- tests/postgres/m14MigrationSessionAdmission.test.ts` before the
complete required gates.
For this boundary, compare the complete catalog shape with the canonical
baseline ledger; separately blocked examples do not establish that comparison.

The migration control witnesses cover legacy/qualified selection and immutable
history in [`platform-migration-manifest`](scripts/platform-migration-manifest.test.ts),
prior exact approval in [`qualified-migration-admission`](scripts/qualified-migration-admission.test.ts)
and the existing source/release checks. The same witnesses retain the exact
sixth runtime-completion fixture, require its selection after the complete
restore-bound prefix and exercise source/group machinery refusal with unchanged
pins. The structural append case removes only that named tail from its previous
plan and supplied migration list before appending it, so the introduced source
cannot duplicate its fixture. These structural checks are not live inventory
qualification. Reader support and the exact sixth-pin approval landed separately
before SQL introduction; the issued qualified 91 preserves legacy 88 and the
entire F90 prefix. The active owner-path forward follows that issued prefix as
qualified unit 92, with its two installed inventories measured in the production
composition witness. The reader reserves it after
the runtime-completion tail, at approval position seven before the five
restricted-bootstrap positions. Its fixed function preimages and exact forward
bytes were approved before SQL introduction; the control witness refuses
changed bodies, extra definitions and an earlier position. The active SQL is
byte-identical to that approved fixture.
The restricted-bootstrap control witness admits the four corrected `qb_`
identities only as an atomic positions 13–16 append after all twelve earlier
approvals, checks their exact fixture hashes, and rejects prior repins or
co-located active SQL. These approvals are inert until a separate selected
generation passes its installation and runtime proofs. The active
[`qualified-admin` witness](tests/postgres/m14QualifiedAdminComposition.test.ts)
uses two disposable PostgreSQL 16 installations with actual non-superuser M
sessions: each resumes after a 17-unit committed prefix, seals its fixed
mode-specific inventory, exercises runtime and restore logins and the existing
connection consumers, then refuses altered inventory, role graph and session
visibility. It does not qualify a hosted endpoint or connected restore.
The
[native session witness](tests/postgres/m14MigrationSessionAdmission.test.ts)
uses the existing runner and container helper: an interrupted canonical prefix
is visible to a second actual migration login, which refuses under the held
lock before pending SQL and preserves the ledger. This generic hook proof does
not qualify a hosted role profile. The [migration owner](docs/platform/DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories)
and [inert fixtures](scripts/fixtures/reviewed-m14-qualified/db/platform/migrations/README.md)
own the separate control-before-installation boundary.

The [released schema-upgrade witness](tests/postgres/m14ReleasedSchemaUpgrade.test.ts)
uses the same canonical runner with a published 77-unit legacy predecessor.
Its [owned child](tests/postgres/m14ReleasedSchemaUpgradeChild.ts) is an exact
public execution entry: one SIGKILL aborts the in-progress backfill transaction,
and another lands between committed units. Run the focused PostgreSQL 16 case
with `npm test -- tests/postgres/m14ReleasedSchemaUpgrade.test.ts`. A local
published 0.23.0 package installed under
`.context/scratch/m14-schema-upgrade/previous-app/node_modules/@openlup/platform`
additionally runs prior package code against the upgraded database; an absent
package does not claim that code-rollback observation.
The [data owner](docs/platform/DATA_AND_MIGRATIONS.md#compatibility-lifecycle)
defines the applicable history and limits.

The restricted-bootstrap reader initially accepted five fixed `qa_` identities
and their exact approval now occupies positions 8–12. A disposable PostgreSQL
install found that the approved actor SQL does not parse. The four corrected
`qb_` actor, acquisition, runtime and import fixtures are separate inert
identities; this additive reader accepts only their complete positions 13–16
append and leaves all twelve issued rows unchanged. The active schema-3 plan selects
the `qa_` baseline with those four `qb_` replacements, the issued
runtime-completion tail and two fixed role-mode inventory digests. The manifest
and admission witnesses reject missing/reordered tails, wrong-generation paths,
issued-prefix repins and partial approvals. A disposable PostgreSQL 16
parse-and-apply witness of the exact proposed bytes in both role modes is
required before the separate four-byte approval packet; active SQL followed
that approval without changing an issued fixture or approval row.

The lifecycle slice uses existing build/API/package/cold-consumer commands.
Owner-local tests cover file conflicts, path boundaries and process interruption;
the installed consumer adds the public export, custom app files, crash/resume
and a no-op falsifier. Range admission remains caller evidence, separate from
actual PostgreSQL compatibility. The existing native cold scenario also invokes
the [versioned application witness](scripts/packages/application-upgrade-proof.ts):
the canonical runner first observes its complete ledger and object inventory,
then two executable app releases use the same schema and installed packages
through an explicitly granted application login. Real control writes/readback,
interrupted file replacement/resume and compatible code rollback preserve durable
data and adopter files. This proves no database migration or hosted profile.
No new runner, container matrix or required job is added.
Its owned child Node witness is registered by exact path in the existing public
execution inventory; the classifier and all other entries remain unchanged.

The same lifecycle selection retains the read-only legacy PostgreSQL role
observer's package and actual database witnesses. The installed consumer checks
its public query/report types, finite prerequisite result, superuser refusal and
redacted error, with a false-admission falsifier. These checks create no installer
or role grants and do not turn a prerequisite report into installation readiness.

The [qualified production witness](tests/postgres/m14QualifiedComposition.test.ts)
checks the owner-path forward's two measured restore-bound 92-unit inventories
through the built package entry and real reference binding, then two fresh
targets in the other role mode
with changed principal names. The E2 predecessor retains its four 89-unit shapes
and eight installations on its own branch. Its healthy target supplies inventory, unsafe-session and
shadow-symbol refusals without replacing expected digests.
Each installation also connects as its actual restricted runtime login to prove
notification row locking and timestamp-only writes, diagnostic replay locking
with actual event-update refusal, and privacy receipt locks, reads/inserts and
populated-row update refusal through the existing production ports. The same four
cases use the normal-runtime preparation binding/lane for context writes and the
review adapters for receipt command/replay, with receipt mutation and context-key
refusals; they add no installation matrix or privileged runtime fallback. Existing
native domain, identity and reviewed-batch fixtures explicitly select the legacy plan
before slicing upgrade prefixes, so the v2 union does not change their issued
SQL, positions or expected legacy inventory. These cases use the existing root
Node discovery and container helper; no gate, retry or test deadline changes.

The portability package witnesses cover private bytes, access/version/integrity
refusals and interrupted resume. The root
[`portabilityRows` witness](tests/postgres/portabilityRows.test.ts) uses two owned
canonical PostgreSQL clusters and compares complete selected rows, replay,
conflict rollback and unchanged migration ledger/ACLs. The existing cold consumer
also executes the declared installed entry and selected-row recovery using its
existing native fixture. These reuse current discovery and runners; loopback
and Docker availability are prerequisites. Local synthetic proof does not
certify full-store transfer or hosted effect fencing.

The prepared [connected-store witness](tests/postgres/connectedStoreTransfer.test.ts)
extends that proof to a fixed native graph and the application's actual private
`objects/tmp` layout. It uses two owned canonical installations, a pristine
target baseline, one migration-owner data transaction and independent row/file
readback. Source media preparation and target media authorization use the actual
restricted runtime login; owner setup cannot establish that runtime capability.
Its selected managed identity projection is stored and read through a PostgreSQL
snapshot before translation into the same qualified restore. Assertions cover
exact issuer/subject derivation, distinct same-email people, human membership
and native revoke-audit subset with source-row reference and conflict refusal,
erasure receipt and re-link refusal, plus unsupported-source refusals. A separate
real-PG case proves source replay, target command drain refusal and both explicit
and maximum drain ends before a new target-key command. This local projection
does not prove managed-provider export authority or full source audit retention.
The existing PostgreSQL helper closes every owned pool/store and removes its
containers, including after setup failure. A privilege refusal before the main
case is a blocked proof, even when the runner reports the case skipped. Record
which assertions were not reached; do not replace the selected role or expected
inventory to obtain a pass. This source uses existing Node discovery and root
test commands. It does not prove all-writer retirement, managed identity/history
mapping, effective storage access or external-effect handover.

The local [handover entry](tests/postgres/runM14EffectHandover.ts) is an opt-in
one-shot fixture, not a required job or serving runtime. In its allocated local
slot, use Node24.21.0, own installed/built dependencies, local Docker and an
already-local immutable Node24.21.0 image:
`node --import tsx tests/postgres/runM14EffectHandover.ts sha256:<local-image-id>`.
Add `--catch-up` to that command for the finite local portable-to-portable
journey on qualified-admin installations. Its private worktree-local report adds
per-table/object counts, interruption/resume, final-generation agreement,
refusal/rollback and takeover facts. The [transfer owner](docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery)
owns the exact boundary; managed history, older-snapshot measurement and hosted
provider qualification remain separate. The final target is distinct from the
preliminary copy and remains inactive through the DB/object/access barriers.
Use `--older-snapshot` instead for the bounded local recovery measurement. It
persists the consistent DB/private-media backup before provider acceptance,
waits approximately 60 real seconds, restores those saved bytes after induced
unavailability and reapplies later privacy obligations before serving. Its
private `recovery-measurement.json` reports numeric snapshot age, effective RPO,
scoped RTO, counts, fixture bytes and separate human/access waits. Declared
readiness includes ordinary-job readback and permits the named uncertain
dispatch to remain fenced. A safe refusal has null RTO; no SLO is asserted.
The host's existing esbuild API emits one ESM for the application child; plain
Node in Linux loads audited existing JS dependencies without a host-native tsx
binary, Linux install or image build. Retain the real metafile, source/output
identities, R sessions, four process IDs, exact backend retirement, final graph/
file census, target publication/recovery and cleanup output. Marker files are
separate from the real media root. Its four executable carriers are declared
in the existing execution inventory; the cohort helper is a regular module.
The fixture establishes its new private scratch root with the current UID/GID
before creating descendants and rereads the actual loopback port after provider
restart. Reserve child container names before launch; a failed OCI start must
still remove the exact created child after checking ownership, while preserving
other named resources. Its passing result covers only the declared graph/media/process profile:
two accepted effects recovered, one uncertain operation fenced and one ordinary
duty dispatched/replayed. Source checks, a predecessor pilot and file presence
cannot establish that result. No new role/grant model, deadline, matrix or global
readiness claim is introduced; prerequisite delivery/admission remains required.

The [S3 source protocol witness](server/adapters/s3/transferObjectSource.test.ts)
uses injected command inputs for protocol refusals and a bounded plain Node
child for actual optional-SDK signing and deserialization. The child supplies
explicit synthetic credentials and an injected HTTP handler; it makes no
provider request. This keeps the SDK's Node export conditions independent of
the test runner's bundler conditions. Its exact test-carrier path joins the
existing public execution inventory beside the S3 storage conformance carrier;
the classifier, command selection and gate remain unchanged. This protocol
proof does not qualify a full source principal, bucket ACL/RLS or hosted storage.

The operations slice uses the existing platform build, API, package and installed
consumer commands. Its owner-local witnesses cover browser closure and preserved
watchdog/handler behavior; the full-catalogue installed PostgreSQL phase also
executes the operations adapter as an explicitly granted invoker role, with a
forbidden neighboring write, durable replay/conflict and a second-process restart.
This extends the existing proof rather than adding a runner or required job.
The existing size/import-map inventories also name the operations browser and
server entries, and the identity profile keeps its exact browser-only closure.


The inventory [binding](tests/platform/inventory/inventoryBindings.test.ts) and
[installed-consumer](tests/platform/inventory/inventoryConsumer.test.ts) witnesses
cover native ATP source-key selection/refusal, managed injected-reader precedence
over `stockRpc`, and reference catalog-stock composition. The real PostgreSQL
[native](tests/postgres/newPurchaseStockNative.test.ts) and
[managed](tests/postgres/newPurchaseStockManaged.test.ts) preview witnesses cover
protected holds, due demand, channel exposure, stale/missing stock and read-option
refusals; the managed witness also checks allocator budget agreement and service
ACLs. The [native inventory witness](tests/postgres/inventoryNative.test.ts)
separately covers store projections and fenced reservation replay/concurrency.

M11 K5/K6 keeps all imported commerce witnesses unchanged. Its additive
`packages/platform/test/composition/commerceContribution.test.ts` and
`server/runtime/public-reference/m11CommerceBinding.test.ts` check explicit
selection, schema refusal, duplicate registration and shared callable identity.
`tests/postgres/commerceComposition.test.ts` uses the installed native harness
to observe a recovery reminder, replay and unchanged active subscriptions,
reservations and undelivered-parcel alignment; Docker absence leaves that proof
unexecuted. The binding installs no route or schedule.

The inert M12 composition tests exercise one guarded owner callable across service,
port and route aliases, disabled/unknown/unsatisfied admission, and M04 receipt
replay. `src/public-reference/accountSupportRoutes.test.tsx` sends browser clients
through the existing authenticated HTTP handlers. The native
[`accountSupportComposition` witness](tests/postgres/accountSupportComposition.test.ts)
installs the complete catalogue, uses Core's actual schema probe and delegates
the selected R4 command to its native store, checking durable receipt replay.
R7 injects the real host-built M11 result, asserts its assignability to the local
selection type and composes actual registry descriptors without sending.
U3/U4 use package-only selections to keep the app project outside the server
adapter graph. U3 follows a refused
continuation and its retry through the selected reference checkout handler with
distinct root/order/client identities and the original key. U4 corrects refused
managed stock options and retries the same purchase without inventing stock.
P2 reaches the native M11 reminder through R5, checks persistence/replay and
compares subscription/reservation/alignment rows including xmin. Reuse M11's
consent/compaction and missing-token-table cases and the inventory unsupported
options/ATP witnesses instead of duplicating their policy matrices. The five
new cases each describe one behavior sequence; independent rows stay separate.
Docker is required; a sandbox socket refusal is missing proof, not a pass.
The installed R5 consumer compiles concrete selections and invalid requests in
NodeNext and Bundler, executes positive/refusal paths, and detects removal of its
packed declaration export or a no-op executor. Its compiler and runtime failures
include the child diagnostics. These local witnesses mount no serving route and
do not replace committed-candidate verification or counted native review.

The [M10 composition witness](tests/postgres/subscriptionComposition.test.ts)
uses its own disposable native database for the complete off/protect/arrival/
rollback/dunning/stock table, shared population lease, schema-object probes and
frozen-mandate refusal. Subsequent-rung committed propagation replay compares
every public row with tuple versions; interrupted propagation is a separate
boundary in the same witness. Its probes name their own installed units rather
than treating an M10 forward as the migration tail. The M10 case in
`scripts/packages/platform-cold-consumer.test.ts` loads the actual packed public
facades and contribution to test enabled execution, readiness/actor refusal and
message identity without workspace imports or live providers. Package facade
and reference M04 delivery tests cover every lifecycle mapping, numbered payment
rungs and receipt replay. The installed M10 consumer compiles the public fact type
and rejects its missing-export mutant. The composed PostgreSQL isolation table
keeps an ambiguous normal or stock row ahead of healthy obligations in two runs;
its no-isolation mutants fail the same witness.

M11 K1 commerce contract witnesses live under `packages/platform/test/commerce`
and join required root Vitest discovery. They cover neutral schema bindings,
strict refusal and replay, generic runtime/offer port fit, fulfillment decisions,
recovery routing, nominal errors, delivery-contact projection and W4 quote
composition. Unchanged reference suites plus a captured pre-extraction parse
transcript protect host extensions. The installed consumer exercises both
entries, one-unit projection/refusal, opaque offer validation and injected
minimum defaults. Quote ports take host-owned types as parameters. Commerce
contracts retain the prohibition on cross-module imports.

M11 D3 extends `pricing/browser` with the existing resolved-acquisition and
shipping-terms validators. `browserBoundary.test.ts` checks their symbol identity
and the exact five-file built browser closure; identity/subscription inventories
add only `shipping/thresholdPolicy.js`. The import-map test permits that pure
leaf only at `pricing/browser/index.ts` and refuses shipping handlers, HTTP,
Node/database imports and sibling access. The reference quote-binding suite
checks optional terms, unchanged absent-term output and strict unknown-key
refusal; existing starter checkout tests cover acquisition refusals.

M11 K2b keeps the pricing-to-shipping value exception confined to the exact
`pricing/browser/index.ts` validator re-export; other pricing code has only the
shipping type edge. The import-map witness retains the nested module/contract
resolver and tests sibling refusal. The installed commerce-server consumer also
exercises draft/runtime/intent/resume store exports, recovery token classification
and hashing, and ordered sweep arguments without a live database.
Both exact server-export inventories retain OMS/returns/effects names and add
K2b stores/recovery helpers. Source and built browser witnesses check the full
commerce closure against identity/subscription exact-file inventories.

M11 K3a adds neutral OMS command, replay and subscription continuity witnesses
and host projection bindings. The managed queue proof at
`tests/postgres/omsQueueLadder.test.ts` replays every current managed forward with
test-only platform prerequisites and compares 18 synthetic orders across every
ladder rung, next action and attention-priority order; Docker absence fails with
a named prerequisite error. OMS reads bind K1's canonical order-money and outbox
exports directly. The installed consumer checks the populated server factory
and its absence from the browser entry, while retaining private-subpath refusal.
The runtime reuses the existing pricing/contracts version and,
only through commerce/server, the shipping runtime entry through explicit module
graph edges. No gate budget, provider requirement or activation is added.

M11 K3b puts handlers/adapters in `@openlup/platform/commerce/server`, with
explicit commerce values and HTTP/BFF type edges; the
commerce contracts entry remains unchanged and imports no pricing. Run the moved
returns/review/media/feedback suites under `packages/platform/test/commerce`,
the reference facade tests, `packages/platform/test/packageBoundary.test.ts` and
`scripts/packages/platform-cold-consumer.test.ts`. The latter also checks that
commerce declarations compile without the optional database peer. Receipt/RPC
fakes prove wire mapping and refusal, while database ownership, concurrency and
replay require their separate native/managed PostgreSQL integration witnesses.

The `@openlup/platform/commerce/server` Node-only entry owns commerce handlers
and adapters. Package-boundary,
module-graph and installed-consumer witnesses inventory it independently, retain
the existing top-level import restrictions and contracts rules, and import its
actual packed entry without changing verification commands, deadlines or artifact
budgets.


M11 commerce keeps browser-safe schemas, pure projections and ports at
`@openlup/platform/commerce`; handler factories and registry composition use
`@openlup/platform/commerce/server`. `packages/platform/test/commerce/browserSafety.test.ts` bundles
that published browser entry with esbuild and checks that source imports,
including erased types, never reach the server entry. The module lint graph
admits fulfillment only from `commerce/server/`; import-map tests exercise both
allowed and refused directions. The new server entry joins the existing cold
consumer's no-optional-peer inventory. These checks add no execution profile,
verification command, budget or provider requirement.


M11 K2 puts checkout engines, handlers and runtime composition in the separate
Node-only `@openlup/platform/commerce/server` entry. Its declared value edges are pricing, shipping, promotions and
inventory; HTTP/BFF edges admit types only. Browser commerce files cannot import
the server subtree or Node built-ins. The import-boundary matrix checks those
permissions and refusals; `packageBoundary.test.ts` bundles the browser entry
with esbuild's browser platform and includes the exact nested export. The cold
consumer exercises installed checkout exports without optional peers and
includes its declarations in the existing NodeNext/Bundler compile proof.

The commerce server compensation witness preserves release, promotion-cancel
and conditional abandoned-order-cancel ordering. Its installed consumer checks
the exact keys and reasons and compiles the cleanup port in both declaration
resolution modes; the reference facade proves function and type identity.

The native subscription renewal selection is
`npm test -- tests/postgres/subscriptionRenewalLifecycle.test.ts --maxWorkers=1`.
It uses one disposable PostgreSQL container for N1 exact-prefix restart,
rollback/replay and old-catalog comparison of routines, relations and attributes,
types, and non-internal triggers, plus retry and captured alignment behavior.
The CTL catalog gate in `tests/postgres/reviewedBatchForwards.test.ts` owns
complete catalog preservation. Initial handoff is tested separately from subsequent retry
failure: the case precedes terminal recording, bookkeeping rolls back with that
terminal transaction, and an immutable receipt ends initial terminal replay
before settlement, rebinding or case propagation. The real-PG witness compares
counts, complete rows and row versions across every public table before and
after three replays per state, including an in-flight prepared retry, later
failure and a re-offered exhausted ladder; it detects notifications, events and
even same-value re-link writes. Fixture-local late database faults separately prove
rollback after the original graph and retry prepare writes; the stock-shortage
case proves admission refusal.
The same selection covers shadow/off admission, protect release after arrival
and lease expiry, manual resolution, open/expired dunning and supersession by a
later paid cycle. Keep the shared harness when extending these witnesses; report
case counts and whole-selection wall time, including startup and cleanup.


The retry-class threading guard in `scripts/retry-ladder-terminating-classes.test.ts`
resolves every production retry call across the core, package and host sources.
Its mutation witness removes the refusal class from each discovered call in
memory and requires the same guard to reject each omission.
It also reads the landed N1 terminating class and all three retry delays and
rejects planted disagreements with the kernel without changing migration bytes.

The native stock-evidence forward uses
`npm test -- tests/postgres/fulfillmentStockEvidenceReplay.test.ts` for six real
PostgreSQL cases: package-port refresh/resolve/reopen, acknowledged and nullable
replay, identity conflicts, legacy fingerprints, row-lock/resolver races and
fresh/exact-predecessor catalogue replay with package/inventory/ACL proof.
`fulfillmentNativeConformance.test.ts` also binds the added sparse descriptor.
The suite needs local Docker and uses the shared container helper's pinned
PostgreSQL 16 image. Run build-producing package checks serially because they
share generated package directories.

The `managedCommerceForwards` registry binds the managed commerce SQL to the
matching files under `scripts/fixtures/reviewed-m11/` and `supabase/migrations/`.
The registry and real migration rails are authoritative. Each pin requires all
earlier same-rail pins with exact bytes. Tests select each real file once,
compare it with its fixture and replay its complete real prefix. Hole, byte-drift,
header, ACL and catalog refusals preserve that boundary.
The new-purchase stock reader
(`public.inventory_new_purchase_stock_read(jsonb,timestamptz)`) runs with owner
privileges through `SECURITY DEFINER` and pinned
`search_path = pg_catalog, pg_temp`; only `service_role` may execute it.
Its ACL revokes `PUBLIC`, `anon`, `authenticated` and `openlup_mcp_reader`.
Behaviour proofs call as `service_role`, with owner access reserved for setup
and state inspection. They also prove function permission refusals for the
denied roles. ATP renewal exemption is fixed false, requests are bounded to
200 array items and a NULL as-of timestamp refuses as
`inventory_stock_as_of_invalid` (SQLSTATE `22023`). Its conservative stale flag
covers any stale provider row for the SKU; the allocator retains its stale refusal.

The managed commerce witnesses in `tests/postgres/commerceManagedRail.test.ts`
execute return ownership/replay and concurrent duplicate calls as `service_role`,
compare complete public rows on refusal, and run the managed stock and starter
pgTAP tests. Stock reads include hard holds, safety stock and protected renewal
demand, with renewal exemption fixed false, bounded input and conservative stale
reporting. The starter witness connects provisional creation to graduation and
replay; `tests/postgres/starterGraduationCadence.test.ts` also checks the permitted
cadences, invalid markers, timezone defaults and the predecessor's refusal.
The catalog gate retains the acquisition finalize matrix under both policy states,
atomic refusals, exact replay, one-time checkout and shared/exclusive locking.
These database proofs do not establish handler integration or native parity.

Migration: configurator guests may supply a destination without rewriting saved
preferences; legacy omitted-country input uses `platform_region_code()` and
requires the adopter's settlement-region configuration.

Migration: return commands require the server-proved principal's owned order and
an identical normalized command for replay. Subscription finalize retains effective
acquisition terms under the policy lock; the terms reader refuses absent policy.
The checkout receipt action, stock seam and starter compatibility actions are
specified in [Data and migrations](docs/platform/DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards).

M12 support authority uses the separate `supportAuthorityForwards` class and
[inert fixtures](scripts/fixtures/reviewed-m12/db/platform/migrations/README.md).
Run `npx vitest run scripts/reviewed-batch-forward.test.ts` for trusted preparation,
co-located own-file pins, PR/merge-group admission, release-introduction binding
and semantic refusal plants. Run
`npm test -- tests/postgres/reviewedBatchForwards.test.ts --maxWorkers=1` with
Docker available for the native and managed finite catalog deltas, complete
prefix replay, observer plants and installation rollback. The managed lane
applies each required M11 fixture exactly once when its canonical suffix is
absent. Canonical bytes and the native packed twin must match fixtures when
present. Missing PostgreSQL/pgTAP fails the prerequisite; lexical checks cannot
replace it. The [migration guide](docs/platform/DATA_AND_MIGRATIONS.md#m12-supportauthorityforwards)
owns the fixed two-path inventory and R4 introduction boundary. These controls
add no installer, package release, activation or general SQL exception.
The M12 dispatcher checks each preceding SQL object's regular-file mode and reads
its exact committed bytes in one batch through the existing documentation object
reader; the complete ordered prefix and all admission checks still apply.

M12 R4 introduces those two files and proves the operator boundary with the
existing runners after serial package builds:
`npm --workspace @openlup/platform test -- test/account-support` for the
operator envelope equality, orchestration and adapter mapping;
`npm test -- --run server/runtime/public-reference/m12OperatorRecoveryBinding.test.ts src/public-reference/accountSupportRecovery.test.tsx`
for the default-off reference binding and surface;
`npm test -- --run tests/postgres/accountSupportOperatorAuthority.test.ts tests/postgres/accountSupportUpgrade.test.ts`
with Docker for native delegation, the eight independently executed native
refusal rows, atomic rollback, fences, races and the upgrade replay; and
`node scripts/public-ci-pgtap.mjs` (Docker) for the managed link,
email claim workflow and recovery fence. The native upgrade witness prints the
real selected-catalog digest for the manifest; a stale manifest is corrected
before the full gate. The packed cold consumer asserts the operator exports'
native link refusal, owner-result identity and linkThenApply ordering; its
swallow-mutation falsifier targets accountReadFacade. The existing M10
`subscriptionCommandLifecycleCases`, M03 `postgresAccountLinkStore` and M08
`fulfillmentDeliveryAlignment` witnesses remain required owner proofs. Missing
Docker or pgTAP is missing proof, never a skip or lexical PASS.

The M10/F17 exact-forward controls use
`scripts/reviewed-batch-forward.test.ts` for per-file refusal plants and separate
and co-located CI/release approval, and `tests/postgres/reviewedBatchForwards.test.ts` for the
mandatory PostgreSQL/pgTAP catalog gate. The latter runs both complete prefixes,
checks exact catalog/ACL/row changes and rollback, and falsifies its observer
with committed attacks. Missing Docker, PostgreSQL or pgTAP fails; the lexer is
only a pre-filter. Fixtures under `scripts/fixtures/reviewed-m10/` are inert
approval snapshots and do not join an installation manifest. The 18-pin batch
has seven native and eleven managed entries; exact 14- and 16-pin histories remain readable. Native order is N1 (`20261022160000`)
→ N2 (`20261024170000`) → N3 (`20261024180000`) → seam (`20261024183000`)
→ allocator (`20261024184000`) → X (`20261024184500`) → Y (`20261024184600`).
Preview replay is folded into N2. Managed order is M1 (`20261024155000`)
→ M2 (`20261024160000`) → seam (`20261024175000`) → M3 (`20261024180000`)
→ M4 (`20261024181000`) → M5 (`20261024182000`) → M6 (`20261024184000`)
→ F17 helper (`20261024185000`) → F17 parity (`20261024185100`)
→ attempt replay (`20261025090000`) → attributed advancement (`20261025090100`).
The M10-9 control fixtures preserve the donor adopter's nine current raw CREATE
hashes through eleven ordered replacement/creation edges. The checker admits
only the first port's exact nullable-column addition, NOT VALID attempt FK,
two deterministic attribution backfills and six exact service/helper ACL
statements. Fully repinned DDL, backfill and privilege mutants refuse. The
managed catalog witness independently derives expected backfill rows from the
pre-forward snapshot and checks column/FK/trigger metadata and unchanged tables;
its plants alter attribution, receipt metadata, helper access, FK validation and
column defaults. A separate transactional subset install removes the historical
baseline's reader grants/policies and role, then installs M1/F17, M2 plus both
ports and M5. It proves service entrypoint execution, browser/host-reader denial,
sealed helpers, fresh legacy NULL refusal (55000) without mutation and an exact
excluded-seam REVOKE negative control (42704). This is subset proof, not a claim
that the whole historical managed baseline installs without its reader role.
The fixtures introduce no counted vocabulary and require no C94 allowance change.
The two managed rail files now match their admitted fixtures and registry bytes.
`tests/postgres/dunningAttemptReplay.test.ts` exercises canonical same/stale
replay, no-write cache refusal, newer advancement with used-token fencing,
both concurrency lock orders, historical attribution and reconciliation's five
named refusal boundaries. The first-port cache-guard mutant must fail the newer
advancement witness. The managed duplicate-observation pgTAP covers delivered
link redemption, class/schedule preservation, independent account rotation and
equal-rung identity conflict. Existing pgTAP fixtures now pass explicit failed
attempt evidence; fresh legacy NULL remains a refusal, never fixture policy.
The package renewal witness captures `durable-attempt-A` at the leaf and every
public refusal parent despite distinct prepared identity and apply replay;
adapter/event-lookup witnesses cover extraction, exact transmission and refusal.
The installed cold-consumer witness invokes the packed public renewal parent and
rejects removal of its applied-attribution handoff using that same assertion.


The native gate also proves paid-line ATP protection, zero-delta late-payment
replay, one-time offer refusal and stale-settlement filtering before LIMIT. N3's normal_due witness covers greater-than-limit and exactly-limit stock waits, interleaved due ordering and no-wait equality with the base reader; waiting/stock_secured cases are excluded before LIMIT.
In folded N2, a raw replay of the command preview returns the stored receipt. All 43
fresh scenarios compare output bytes and public-table columns against the pre-fold preview body and folded N2;
committed replays compare counts, all columns and xmin across a later command,
and the apply definition remains unchanged. Table-driven N2 witnesses cover donor
no-op truth mapped to native bundle/resize, plan, package, add-on and slide commands
before repricing, even after catalogue prices change: only the actor/key receipt
is written; every other public row, column and xmin stays unchanged. Native resize
compares lines/cadence; portion mode/factor remain host-owned without native storage.
Each row checks the changed-state preview/refusal and rejects its predicate-removal
mutant in a rolled-back savepoint. The existing add-on rows retain actor/key replay,
different-quantity duplicate refusal, new-add-on behavior and rejection of both
unconditional-append and guard-only bodies.
The change-semantics table also applies each bundle, resize, plan, package and
add-on quote and compares every requested line, price, cadence and future term.
Plan changes use supplied core lines; new add-ons default/clamp quantity to one;
add-on actions preserve cadence and compare variant UUIDs by value. Drift and
stale-template refusals, receipt-only no-ops and replay remain covered. N3 rows
check current-obligation frozen reads, paused-wait preservation, eligibility
before LIMIT, separate own/available deficit quantities, and closed/unpaid
realization null no-ops followed by paid realization and zero-delta replay.
Assignment/predicate mutants must fail the same witnesses inside rollback savepoints.
Uncaptured N3 discovery uses real allocator refusals without wait rows: missing
or stale stock keeps one recovery failing while a replenished refusal passes
through `candidates(1)`. The operation selection stamp advances independently of
case creation; restoring case-only stamping must fail the same table in rollback.
Root test discovery
already includes both suites; no extra runner or optional skip is introduced.
The M10 gate reads its native PG16 and managed Supabase PG17 pins from
[the CI image inventory](config/ci-images.json), with mirror-first fallback as
specified in [CI image mirror](#ci-image-mirror). The gate
uses the shared pull module to reuse an exact local pin or verify the pulled
RepoDigest. Transient pulls retry at most three attempts per source within a
300-second pull budget; retries share each source's deadline and reserve time for fallback as described below. Retry-After
above the source's share of remaining time advances to the next source;
otherwise waits are capped at five seconds. An unavailable mirror advances
immediately. Inspection, container-start (except the shared helper's existing
port-rebind retry) and SQL failures are outside the pull retry; exhausting
sources fails without a skip.


M09 composition checks extend the invoicing required selection and installed
cold consumer with explicit selection, default-off and successful host execution.
Real-Postgres store/adapter rows exercise the pinned seller wrappers, asserting
results and persisted state for request, claim, retry and refusal branches.
No fiscal provider or account access is required.

M09 native invoicing uses real-Postgres conformance cases and the package
store/binding witnesses in `packages/platform/test/invoicing/postgresStore.test.ts`. The native harness includes fresh complete installation, preserved
prefix upgrade, exact catalogue hashes, invoker/browser ACL refusals, keys and
leases, scoped claims, incumbent fencing, scale and same-order dispatch under
accounting contention. Its whole-file budget is 28 seconds excluding container/harness setup (report setup
and per-case time separately), with additional M09 evidence in
`tests/postgres/invoicingStoreContract.test.ts` (72 rows) and
`tests/postgres/invoicingContinuity.test.ts` (3 cases). The required package selection includes the store
cases, and the existing packed consumer verifies the store, issue binding, migration
descriptor and independent collector exports, plus all seven SQL asset hashes
without a driver installed. These
checks establish the native persistence/continuity slice and offline issue binding,
without fiscal provider readiness. The approved re-pin regressions share the native
cases: stored-reversal before-send/absence handling, retryable readback remaining
unknown, latest terminal/resolved capture fault per source kind/ID, and exact
cutover seeding before FK tables with a concurrent order writer. Keep the
28-second whole-file ceiling when extending these cases.

For managed correction changes, run the real PostgreSQL
`tests/postgres/invoicingManagedCorrection.test.ts` and shipped
`supabase/tests/accounting_correction_recovery_test.sql` through the managed
pgTAP runner. The former exercises the actual v2 adapter, identity/reclaim,
fences and roles; the latter retains committed-ACK, delivery and audit replay
witnesses. The invoicing contract test also covers correction and reversal outcomes without
another setup. Required package selection includes this file and the existing
packed consumer. These checks do not establish provider wire or fiscal proof.

Subscription package contract changes use package-local contract, identity and
port-fit witnesses alongside the generated package boundary census. The cold
consumer classifies both exact subscription entries as having no optional peer
requirement and exercises their installed declarations and runtime refusals.
Native command cases run in the shared N1/N2 lifecycle harness: they bind the
supported descriptor to real future-term/replay behavior and prove prepaid
refusal and full transaction rollback without replacing SQL with doubles. Plan-length store rows check supplied core quantity and variant changes in quotes,
persisted lines and future renewal terms, with unchanged-line/day no-ops and receipt replay.
Typed future-term rows cover the same quantity and variant changes through
`createPostgresSubscriptionCommands` and its package-template translation. Raw PostgreSQL cast/overflow messages are
normalized to a closed refusal code, including when read from stored receipts.
Adapter replay returns before mutable host future-term validation; changing the
host address policy after commit cannot replace the original receipt.
Preview and apply replay compare counts, all columns and `xmin` across every
public table, with three replays before and after a later different command.
`tests/postgres/subscriptionContinuityBaseline.test.ts` uses the full current
native manifest and disposable Docker harness for arrival maximum, exhaustion
and captured-case rollback behavior; it must not replace a failed invariant
with a mock, skip or admission bypass. These focused witnesses complement the
existing complete contribution gate and establish no runner activation. Declare
the subscription module in the ESLint graph with a browser contracts subtree
and no cross-module edge; existing provider and package isolation rules apply.

Fulfillment preparation conformance runs the production reference writer under
its advisory and shipment row locks in
`tests/postgres/fulfillmentPreparationBinding.test.ts`; the packed
`scripts/packages/platform-cold-consumer.test.ts` scenario also covers the
fulfillment services and contribution from installed bytes.

Native fulfillment conformance uses the existing Node collector and disposable
PostgreSQL harness in `tests/postgres/fulfillmentNativeConformance.test.ts` and
`tests/postgres/fulfillmentDeliveryAlignment.test.ts`. It covers complete install and
prefix upgrade/replay, fences/ACK recovery, arrival/replacement invariants,
locks/rollback and actual denied browser privileges. Retry/admission
cases distinguish existing-cycle recovery without receipt changes from guarded
new-cycle inserts. Docker unavailability fails these required proofs; report
container setup separately from case runtime. This adds no collector, profile,
coverage budget or live provider dependency.

The payment reference-support rebinding reuses existing host and producer cases:
localized callback/query and simulator-return parity, nominal no-charge retry,
customer/setup metadata and inert default-off construction are assertions inside
existing cases. Duplicate root suites retire while their package witnesses stay.
The packed consumer checks the eleven additional experimental vendor exports,
no leakage into neutral payment entries and no SDK or import-time I/O. Its local
pack/extract fixture needs no package installation; provider-account verification
and hosted time-budget evidence remain separate obligations.

The opt-in payment example retains donor execution, decline, refund, lifecycle
and purpose-sensitive readback witnesses in the existing Platform/root Node
collectors. Its focused factory tests add neutral-envelope and refusal coverage.
The cold installed consumer imports the explicit subpath without a provider SDK,
blocks ambient network and file writes, and exercises injected execution with
transient-secret isolation. Import-time module loading still reads installed
JavaScript. The narrow provider-vocabulary allowance is path/token-scoped to its
approved category; paired outside plants and other categories retain the ratchet.
These focused proofs do not replace required coverage, native review or the
shared installed-artifact gate.

The portable dunning invariant repair adds
`tests/postgres/dunningLifecycleActiveRepair.test.ts` to the existing Node
collector. One static case checks unchanged SQL bytes and the manifest binding;
nine real-PostgreSQL cases use the existing disposable-container harness for
fresh install, exact-prefix upgrade, cycle preservation, exhaustion/replay,
recovery and actual browser-role EXECUTE refusal. Missing Docker explicitly
skips the database cases and is missing proof. Once a container starts,
readiness or SQL failures fail the suite. Runtime calls use a limited synthetic
application role; owner reads observe rows without granting browser access.
No runner, profile, default composition or coverage budget changes.

Row 24b's bundle/pricing parity uses existing collectors: package selector and
concurrent-authority suites, the reference preview binding, and six native cases
in `tests/postgres/bundleEffectiveParity.test.ts`. That witness uses the full
canonical chain and existing disposable PostgreSQL harness, refusing unavailable
Docker. Existing catalog/pricing suites remain unchanged. No profile, runner,
coverage budget or default composition changes.

M05 parity seams keep the existing Node package collector. The promotions suites
`shippingConsentParity`, `thresholdShippingParity` and
`acquisitionOrchestrationParity` exercise opt-in bindings and omitted-binding
compatibility alongside unchanged pricing/promotions/shipping and reference
suites. Pricing injects orchestration and imports only shipping types; promotions
uses the shipping server policy through the declared module edge. Browser
contracts remain type-only. These source checks do not replace committed package
and installed-consumer gates.

M05 P7 adds five explicit cases across
`tests/postgres/m05CatalogComposition.test.ts`,
`tests/platform/catalog/m05Composition.test.ts` and
`tests/platform/catalog/m05ReferenceComposition.test.ts`. The three PostgreSQL
cases cover replay/contention with independent real transactions, native consumer
readback and mounted admin/feed readback with an injected stock reader. The
readiness case runs the existing SDK-absent packed-consumer scenario for the moved factories, descriptor and inert contribution; its local
packs are working-tree feedback, not the supervisor's signed-artifact gate.
The SSR case exercises the existing static pages and unmounted route inventory.
Run these files explicitly under the existing collector; Phase A contributes
four cases and Phase B adds the mounted readback case, with no skipped test.
No collector, coverage budget, resource gate, dependency classification or
default profile changes. The catalog server remains an adapter entry; composition declarations
remain usable without optional database peers.


Reference catalog UI conformance remains in the existing Node/DOM discovery.
`referenceBuilderConformance.test.ts` uses the real persisted-state codec and a
save/reset/reload transcript to protect selected quantity/mode, signed quote
transfer, navigation refusal and fresh consent after edits. The catalog SSR case
checks supplied media/details and legacy fallback; the page DOM cases protect
locale deep-link hydration and authority-only lifecycle/refusal rendering.
Promotion binding tests compare local/server schema semantics and bundle the
actual browser clients/dialogs with positive schema-input controls. Collect
changed files explicitly before running their focused paths; these witnesses
add no runner, profile mount or package activation.

Bundle native read extraction adds five cases under the existing
`tests/postgres/**` collector, using an owned disposable PostgreSQL container and
the complete canonical manifest. No test selector or runner changes. Catalog's
server entry now has a type-only data edge and adapter declaration classification;
the cold consumer still imports and exercises the supplied executor with optional
peers absent, while server declarations compile after selecting peers. Contracts
remains non-adapter. The binding case uses the declared rolldown bundler, checks a
positive platform-input control and parses a non-empty feed through the actual
reference schema. Package smoke evidence lists package-owned paths only; root
binding and database proof remain root-collected. These working-tree checks do
not replace the supervisor's clean committed-candidate package gates.

Bundle application/admin extraction reuses the existing platform catalog entries,
module graph and test collectors. Only http/bff types cross module boundaries;
reference schemas, shared admin kit/spec and RPC error subclass remain injected.
The five package bundle suites retain 44 cases and two root binding suites retain
18. Four neutral composition/stock/allocation/refusal/authority cases plus one
DTO/schema and browser-closure binding case add five executed cases. No Vitest
configuration or required selector changes. Catalog server now retains its adapter classification for the native data
executor type; its cold-consumer transcript adds composition refusal, honest unknown
stock and exact per-line allocation without optional peers. Native store/SQL proof
is separate. Uncommitted relocated files still require the supervisor's committed
inventory/package checks; local candidate ownership checks do not replace them.

Promotion admin/native extraction keeps the existing checks and runner selection.
The module graph admits type-only data/http/bff edges for executor and admin
bindings; no runtime data edge is needed. The server entry's declarations reach
optional pg types, so cold consumers classify it as an adapter, import it without
pg using an injected executor, and compile it after peer selection. Contracts
remain a non-adapter and compile in both modes without peers. Native-store query
doubles and contract/port suites move under the package. Handler subject cases move to
`tests/platform/promotions` because they bind the actual shared reference admin kit. The
one global-environment composition case stays at its original reference path;
copying that kit into package tests would create another authorization authority.
The dedicated `tests/postgres/promotionsNative.test.ts` installs the full canonical
chain and proves only incumbent native read/lifecycle/sweep/grant behavior; it
neither imports managed schema nor claims pending code/mounted parity outcomes.

The earlier P3a promotion application move reuses root/package discovery for the retained
suites in platform `test/promotions/`; its managed RPC-name assertion remains at
the reference transport boundary. The preview suite still checks the reference
create-schema refusal alongside package preview behavior. Neutral synthetic
fixtures replace default currency/country and legal-basis text without changing
assertions. Four W3 application transcripts, one callback terms case and one
reference host-binding case add six required cases. The existing fixed-token
consent witness remains local. Both promotions entries extend the existing cold
consumer import/declaration proof and its application-to-acceptance transcript;
no runner, optional peer or database obligation was added in that application slice.

The opt-in pricing acquisition suite adds synthetic schedule, policy refusal,
v3 negotiation/freshness and boundary readiness evidence to the existing package
smoke inventory. The retained reference consent witness covers explicit terms
and fixed historical token bytes. Both run through existing discovery; no new
runner or graph value dependency is introduced. The cold pricing consumer also
checks the missing-policy refusal and separate promise comparison API.

Pricing P2a moves the incumbent authority, subscription policy and token suites,
and the pure error-mapping case, into platform `test/pricing/` discovery. Root
and package discovery already include this directory; no duplicate required
selector is added. The reference retains configuration/readiness composition
coverage and one browser-schema/error-identity binding guard. Both pricing
entries extend the existing optional-peer-free cold consumer and declaration
compilation. P2b moves the existing quote-equation, provenance, tax-guard, quote-port,
snapshot-verifier, quote and batch handler, offer pricing, cache and readiness suites
to the same discovery, with unchanged assertions, neutral fixture values and
package-local fixture bindings. Three reference cases protect browser/server schema
parity, error identity and the observed request binding of the three handlers; the
rich catalog-adapter and promotion-implementation suites remain local. No extra
required test invocation is added.

The M05 catalog module relocates eight existing catalog suites into the platform
package's `test/catalog/` discovery, preserving their assertions. Root discovery
already includes that directory, so no duplicate selector or second invocation
is added. The reference observed-responder binding has one local guard. Both
catalog entries join the existing SDK-absent cold consumer and declaration
compilation; its installed witness checks the unchanged canonicalizer, authority
error identity, exact selection and unauthorized draft refusal. Local dirty-tree
checks do not replace the supervisor's committed-candidate package proof.


The installed communications consumer checks the exact contracts value inventory
and renders a synthetic message with network access refused and optional peers
absent. That entry contains pure rendering/building and copy-injected factories;
its browser gate measures the complete built runtime export closure. P3 changes
only this prior empty-value expectation and its rendering proof, retaining the
other installed-consumer, missing-peer and type checks.


The M04 communications import extends the existing platform consumer and required
selection with its retained reference witnesses. The isolated contracts entry
compiles without optional provider peers; the mixed server entry compiles after
selecting the existing PostgreSQL peers. Its packed proof checks no-egress capture,
optional-driver refusal, four exact canonical sparse SQL projections and durable
receipt replay, conflict and access refusal in the existing owned disposable
PostgreSQL lane. B3 adds useful installed polling, sync, recipient-directory and
consent operations after the complete canonical catalogue is installed by the
existing reference runner in a separately owned cluster. Negative fixtures reject
no-op stores, wrong tokens, false delivery and repeat execution; the required
native PG/binding selectors also cover upgrade, replay, ACL refusal and atomic
rollback. Managed paths, concrete mail protocol mapping and activation remain
reference-owned; no check, budget or clean-candidate gate is relaxed.
These additions do not create another runner or relax required coverage. The
producer still requires a clean committed candidate, so local uncommitted checks
must be followed by the supervisor's exact signed-candidate package gate. The
[M04 ledger](docs/platform/plans/oss-m04-communications-triggers.md#verification-ledger)
retains the cumulative case/time allowance and preview limits.

The platform packed consumer includes the opt-in OIDC adapter: imports and
construction remain inert without the selected JWT library, selecting an absent
library produces the documented availability refusal, and the direct account-link
store retains the optional PostgreSQL-driver refusal. Real issuer certification
is separate from this cold proof. Its disposable local recipe, prerequisite
refusals and command are owned by [identity conformance](docs/platform/IDENTITY.md#real-issuer-oidc-recipe);
it runs outside default CI and requires the cached pinned issuer image.

The runtime-forward checker also binds eight exact legacy policy retirements
by table, name and preceding CREATE POLICY statement hash. It requires their
ordered DROP statements before the fixed grants and rejects missing, duplicate
or additional policy operations. Both PR and release-history tests check these
refusals and the canonical
[co-located SQL/pin rule](docs/platform/DATA_AND_MIGRATIONS.md#co-located-sql-and-approval-pins).
These checks admit one reviewed contraction; they do not grant general policy edits.

M09 control preparation adds seven final SQL fixtures without installing them.
M09 lands before M10 and keeps its versions; see the
[M09 forward owner](docs/platform/DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval).
Its only data-reading install seed is the exact keyed cutover `INSERT ... SELECT`
from settlement transitions and shipment operations, admitted once into the newly
created cutover table. The re-pinned duty fixture seeds that table before
FK-bearing tables acquire order/accounting locks; its whole-file pin binds this
installation order as well as the stored-reversal void and latest-fault readback
bodies. The admission classifier and exact seed literal stay unchanged.
The class also admits the invoker-rights view form;
arbitrary seed SELECTs and data-reading defaults gain no new admission.
Checker plants use landed invoicing bytes when present, requiring exact equality
with the reviewed fixtures, and use fixtures before introduction. They exercise
PR and release admission, then refuse byte drift, browser grants, donor attribute drift and unpinned
replacements. Separate structural plants refuse replacement syntax in managed
creation files, missing function grants/revokes, changed managed search paths and
unsupported view options. The release suite repins the managed search-path
mutation and the `security_invoker=false` view-option mutation so semantic
refusals run after the hashes pass. A view without a WITH clause stays structurally
admitted; for M09, the whole-file pin and the catalog proof's
`security_invoker=true` reloptions check refuse it.
Native trigger plants distinguish a missing in-file
function from a defined trigger function: the latter passes structural
classification but fails the M09 whole-file pin in PR and release admission.
The existing real-PostgreSQL catalog suite applies all fixtures in
one owned container: native additions preserve prior objects and close browser
ACLs, the payment-terminal replacement preserves incumbent attributes, and managed
additions retain the donor's fixed-path, service-only definer authority. The
[M09 design and retry contract](docs/platform/DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval)
owns the duty sweep and feature introduction boundary. These checks do not
introduce canonical migrations, broaden the fixed SQL class or replace
feature-level settlement, dispatch, correction, seller and delivery invariants.

The reviewed runtime-forward checker admits an exact pinned five-function SQL
file and an optional identity capabilities file with fixed service-only client
writes, operator activation inserts and invitation email reads. Tests exercise both PR history and release
history admission, including independently repinned forbidden columns, roles,
writes, functions and changed execution attributes. Approval follows the
canonical co-located rule above, including its separate prior machinery-control
boundary. Passing these tests is admission evidence, not proof that a draft
overlay is the shipped chain.


<!-- openlup-doc-impact {"unit":"tooling","digest":"sha256-7754f9a24ad3a5e6f570d6599e69a966ef6655741c48b1bb48f041236192b975","reason":"The shared admission function and predicate refuse control characters other than tab and line feed in migration SQL (parser parity with PostgreSQL), with focused and tracked-rail regression tests. The Additive forward release path in DATA_AND_MIGRATIONS documents this refusal. Contributor commands, required test selection and gate order in this section remain unchanged."} -->

Start with the [development, diagnostics and preview-release sequence](docs/platform/DEVELOPMENT_AND_RELEASE.md)
for where each check runs, Draft/Ready/queue/main triggers, blocking versus
diagnostic results, and the source-to-npm handoff. This section owns the detailed
contributor commands; the overview links here rather than replacing them.

`npm run oss:published-tree -- --policy` also keeps agent guidance in place.
It refuses an `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` or `.cursor/rules` file
anywhere but the repository root or a package root. It also refuses an adopter
kit whose `docs/platform/adopter-kit/dependabot.template.yml` group misses a
published `@openlup/*` package. Move such a file or extend the pattern; do not
add an exception.

### Local stack bases and heavy verification

Ordinary independent pull requests use the existing fork-point base. Stacking
is optional. For an upper branch, export `OPENLUP_STACK_BASE=<full-predecessor-SHA>`
before documentation checks, native `prepare`/`record`/`verify`, and final local
verification. The pin must be an ancestor of HEAD and a descendant of its fork
point. It is the reviewed candidate's base; changing or
removing it does not reuse an old review. Documentation uses that same base,
including its no-impact fingerprints. Hosted event attribution still wins.

Review the upper change relative to this exact predecessor, with the predecessor's
contracts as context. Source and group admission independently require the
reviewed base to have reached actual `main`; an unchanged group tree cannot
waive that prerequisite. A predecessor-only landing
then preserves the upper candidate, coverage, reports, expiry and repair history.
Default unstacked reviews retain their existing fork-point refusal rules.

For each heavy final local command, use:

```sh
node scripts/agent-review-session.mjs verify-command --resource openlup:coverage -- npm run test:scoped
```

Keep every required command below, including package gates and coverage, unless
an authorized supervisor establishes the bounded [mechanical integration
alternative](#native-review-and-accountability). This wrapper adds no test
selection, cache, stamp or authority; it does not establish complete local proof
from one successful supplied command. Before starting the
command, it checks the clean committed candidate and its native review. After
the command exits, it checks candidate identity, cleanliness and review validity
again. A changed candidate or expired review refuses final evidence; a valid
candidate preserves the underlying command's exit code.

With `--resource`, the wrapper requires `ai-resource-gate` on PATH and runs the
command through its waiting admission route. Select the existing profile for
the actual command, such as `openlup:coverage`, `openlup:build` or
`openlup:typecheck`; the resource key uses a stable numeric worktree suffix, so directory names
cannot select a different broker lane.
The broker's configured CPU/RAM, timeout and refusal policies remain binding;
the wrapper defines none of them. Without `--resource`, it runs the command
directly. It refuses invocation inside an active resource broker or another
verification wrapper, so wrap the underlying command once.

Freeze tracked inputs and serialize commands sharing mutable output. The wrapper
adds no output lease or policy/inventory check. Its cheap predicted-merge
preflight reuses queue carry-over against locally fetched `origin/main` before
the command starts; refresh that ref before final verification. It performs no
intermediate candidate check after a broker wait. It passes the
existing environment, including any `OPENLUP_STACK_BASE`, to the child command.
Run the separately required checks yourself; existing maintainer-local stamps
and hooks remain required where installed. This wrapper is local verification,
not hosted admission or evidence of deployment readiness.

### Optional SonarQube Cloud diagnostics

The SonarQube Cloud OSS pilot uses one public project and automatic analysis of
pull requests and `main`. Its source and test scope is defined in
[`.sonarcloud.properties`](.sonarcloud.properties). Activation requires a GitHub
App installation and project import by an authorized organization owner; the
file alone does not activate scanning. Keep automatic repository import off.
The pilot adds no required check, scanner job, coverage run or package dependency.
Do not enable automatic and CI-based analysis on the same project.

Use custom JavaScript and TypeScript quality profiles focused on security
vulnerabilities, security hotspots and reliability rules that add a signal beyond
the current ESLint configuration. A hotspot is a request for contextual review,
not a confirmed vulnerability. Retain supported GitHub Actions and Docker security
rules. Keep existing import, port, neutrality, type, secret, migration, API and
publication checks authoritative; do not reproduce them as new Sonar obligations.
Compare individual overlapping rules before deactivating them in the Sonar
profile. Never disable existing repository controls to accommodate a finding.
Duplication and cognitive complexity are advisory; coverage is not imported in
automatic analysis and must not be a pilot gate condition. Keep the project gate
informational in GitHub, including for merge groups.

The scope retains entrypoints, domains, adapters, browser code, package source,
MCP and executable tooling together. Tests and fixtures are classified separately;
generated types, build output and PostgreSQL SQL are excluded from production
analysis. Check the first analysis for the expected source/test classification,
language coverage and unresolved TypeScript context. Incomplete analysis is not
a clean security result. Record the analyzed commit and active profiles when
assessing findings; a PR result needs a current target-branch analysis.

The PR author resolves confirmed new defects in that PR and checks the next
analysis. Triage existing `main` findings once, then select small regression-tested
repairs by demonstrated impact. Do not create issues automatically for every
finding or combine unrelated cleanup. Deduplicate findings by mechanism and
location, including Gitleaks findings. Record false positives or accepted cases
with a reason in Sonar; do not add blanket source suppressions. Follow
[SECURITY.md](SECURITY.md) for sensitive vulnerability details.

After 30 PRs or four to six weeks, whichever is later, assess additional confirmed
defects, false/duplicate findings, analysis latency and triage time. The pilot
targets at most 30 minutes of weekly triage after calibration. Runtime and useful
finding counts are measured outcomes, not promises. Required merge admission,
coverage import, multiple Sonar projects and automated remediation require a
separate decision after this evidence.

Configuration references: [automatic analysis](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/automatic-analysis),
[quality profiles](https://docs.sonarsource.com/sonarqube-cloud/standards/managing-quality-profiles/understanding-quality-profiles),
and [PR analysis](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/pull-request-analysis).

### CI image mirror

The separate [CI image mirror](.github/workflows/mirror-ci-images.yml) runs in
`openlup/openlup` on pushes to `main` that change one of its three input paths
(the image inventory, the mirror script and the workflow), and on manual dispatch
from `main`. Its single job reads only the committed
[image inventory](config/ci-images.json): install-proof PostgreSQL, which is also
the pgTAP server and the managed-rail test database, and the test harness default.
Every pin is validated before the first registry request. No Supabase CLI or
derived image set takes part.
The reviewed-batch gate and shared PostgreSQL test helper read these JSON pins
through [the shared reader and pull loop](scripts/ci-image-pull.mjs). The reader
imports the JSON module directly so the same pins load in plain Node and both
Vitest projects, including jsdom. In CI and locally they try the organization
mirror first, then the upstream order with the same digest: managed uses GHCR,
Docker Hub, ECR; native uses Docker Hub, ECR. Private or absent organization
packages do not remove these public upstream fallbacks.
Disposable PostgreSQL suites use `postgresSetupTimeoutMs` (600 seconds), including
the existing 300-second cold image pull and schema installation, and
`postgresTeardownTimeoutMs` (45 seconds). These are explicit integration-hook
budgets; ordinary test deadlines remain unchanged. The shared helper bounds
Docker availability to five seconds, each start/removal command to 30 seconds,
and TCP readiness to 60 seconds of wall-clock time, including connect/query
attempts and waits. After image resolution, port-conflict retries share a
60-second startup budget; failed-start cleanup still gets its 30-second removal
budget before reporting failure. Readiness destroys its throwaway client after each probe.
`closePostgres` gives all fixture pools and adapter/store close callbacks one
shared five-second close phase, then attempts every owned container removal even
if a close failed or stalled. Suite teardowns pass opaque adapter closers into
that phase instead of awaiting them first. All removals finish before cleanup
reports its collected failures. Separate elapsed timings identify the slow phase;
an already absent container is the only ignored removal error. Secondary upgrade containers are acquired by the owned `beforeAll` fixture,
registered immediately, and ready before the 60-second test bodies begin.
A body that times out before its local `finally` therefore cannot leave a pending
acquisition that returns after suite teardown. Local `finally` blocks reuse the
same bounded cleanup.

The helper's default is the pinned test PostgreSQL image; explicit images retain
their behavior unless they exactly match an inventory pin. Shared acquisition
first inspects every source locally and reuses only an exact pinned index digest;
absent or nonmatching pins require pulling, while daemon/inspection errors refuse.
It resolves once per process per exact input reference before port retries, then
runs the successful
reference with `--pull=never`. Explicit pinned overrides first verify the exact
local RepoDigest, avoiding a second pull phase after the gate resolves its image. Failed
resolutions are evicted from that process cache.
The gate, helper and pgTAP runner use the same pull implementation. It tries at
most three times per source within a 300-second pull budget measured with a
monotonic clock, including local inspections and final digest verification.
Retries share a source deadline. With multiple sources, 60 seconds of the
300-second budget is reserved across the remaining sources: a first cold pull
can use up to 240 seconds, while a stalled first mirror cannot consume every
fallback's opportunity. Fast refusals leave their unused time available. A
single source retains the full 300 seconds. A shorter caller budget scales the
reserve to 20%. Pulls receive their remaining source time, clamped to at least
one millisecond. These are execution limits, not a throughput guarantee for a
large cold layer; calibrate them against hosted cold-pull measurements. The
300-second total still leaves half the gate's 600-second hook for startup and
the migration prefix.
Retry-After seconds and Go subsecond units above the current source's equal
share of the remaining budget immediately advance to the next source.
Otherwise 1s/2s minimum waits are capped at five seconds and the remaining budget;
expiry prevents another pull. Backoff adds at most 10 seconds per failed source
(30s native or 40s managed per image), all inside the pull budget. There
are at most nine native or twelve managed pulls per image.
The shared loop retries transport, context-deadline, killed process timeout,
registry 5xx and 429 failures. Mirror not-found,
denied or unauthorized errors immediately fall through without retry. The
managed pin has upstream GHCR, Docker Hub and ECR fallback; library PostgreSQL pins retain Docker Hub/ECR
fallback in CI and locally. An empty or private organization mirror therefore
does not by itself fail these consumers.
Local daemon/disk/malformed failures, upstream non-transient errors and pinned
RepoDigest mismatches refuse rather than silently selecting another image.
The gate's offline guard rejects literal digest pins or registry source lists.

The pgTAP runner pulls its single image, the install-proof `postgres:17` pin,
through the same loop and starts it with `--pull=never`. Every pull and local
reuse requires the exact pinned index digest; the loop refuses a tag-only input.
No upstream push or registry
write occurs. Other launchers retain their existing acquisition behavior. The
install-proof service retains its digest-pinned Docker Hub PostgreSQL 17 image,
which is pulled before workflow steps run and does not require an organization
package.
An upstream source may retain an explicit tag only when it matches its JSON tag;
resolution preserves that spelling and always verifies the pinned digest.
The script resolves upstream tags to digests, copies complete indexes to
`ghcr.io/openlup/<upstream-repository>:<tag>` (slashes retained), skips identical
target tags, refuses conflicting tags and verifies the digest after copying.
Only the mirror job receives `packages: write`: it reads owned pins from its own
checkout, refuses a missing digest or two pins that would write different digests
to one target, and runs only SHA-pinned first-party actions plus the
dependency-free repository script. A moved tag is refused.
The token reaches login through environment and stdin after validation and resolution,
immediately before copying; a `finally` block removes the temporary registry
credentials.
The mirror never re-points an existing tag, so an owned pin's digest bump must use a
new, more specific upstream tag; the old target tag stays as it is.
Offline planning, skip/refuse and verification tests accompany exact workflow
trigger, permission, checkout and credential-transport assertions.

One-time owner setup is required: organization **Settings → Packages → Package
Creation** must allow Public packages (and initial private creation, because
GHCR creates packages private). After the first authorized run, for each package
under **openlup → Packages**, use **Connect repository → openlup/openlup**; in
**Package settings → Manage Actions access**, add that repository with **Write**
access if inheritance does not already grant it. Under **Danger Zone → Change
visibility**, select **Public** and confirm. Check anonymous mirror pulls after making packages public; consumers already
fall back while packages are absent or private. `GITHUB_TOKEN` cannot make a package public; linking a public
repository does not change package visibility. See GitHub's
[package access and visibility procedure](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
and [repository linking procedure](https://docs.github.com/en/packages/learn-github-packages/connecting-a-repository-to-a-package).

### Required and raw checks

Use the Node version recorded in [.nvmrc](.nvmrc), npm 11.19.0 (the
`packageManager` field of `package.json`), and the committed npm lockfile. CI and
release workflows pin Node 24.21.0, which bundles npm 11.19.0, so newer Node 24
releases cannot change npm beneath the existing assertions. `.nvmrc` pins the same
24.21.0 runtime locally; the npm contract is unchanged. From
the root of a materialized development-preview tree, these are the commands the
mechanical/diagnostic jobs of [Published Tree CI](.github/workflows/published-tree-ci.yml)
run; each comment names its job. The inherited `native-review` job additionally
checks exact-candidate admission when the maintainer enables `OPENLUP_NATIVE_QUEUE`;
its six required dependencies and merge-group metadata controls remain unchanged:

<!-- openlup-doc-impact {"unit":"public-checks","digest":"sha256-0f53d76126bb6c40cdd7bc03ed7114f24836b4ea75ee30c26a09c95d0e173568","reason":"Merge-commit landing support. The source-preview release preflights accept a target only on main's first-parent line, so a commit inside a pull request merged as a merge commit is refused; under squash history every main ancestor is first-parent, so behaviour there is unchanged. The required contexts and contributor commands described here are unchanged."} -->

The bundle binding proof derives stock reason codes through the existing host
helper before comparing wrapper and package output. The native read proof keeps
its no-write snapshot assertions inside a `try` and removes only the inserted
tier-price rows in `finally`, so its fixture cannot affect later write cases.
These changes retain the existing cases and assertion operators.

The second opt-in payment example extends the existing narrow vendor allowance
and permits its market currency token only in its own source/test directories.
Each vendor's full-content allowance matches only its own source/test paths.
Paired real-scanner plants keep vendor and currency vocabulary outside those
paths counted, including each vendor word inside the other adapter's source
and test directories. Its offline witnesses retain all donor cases as moved-pending;
the reporting zone is allowed only on the exact readback declaration at its
exact source path, with outside-line/path plants and no baseline increase. An
excess allowance fails closed with an actionable error naming the category,
quoted path and negative remainder. Scanner-count plants exercise payment,
communications and adoption subtraction lanes.
New attempt/redaction/envelope/validity/freshness cases are counted separately. The packed payment
consumer imports both optional subpaths with ambient I/O disabled and no SDK.
Focused loopback transport tests fence every socket except their disposable
local listener; they never establish provider-account readiness.

Required root `test` accepts only success from all four `test-full-shard` jobs;
failed, cancelled or skipped shard jobs refuse it. Main-push reuse requires a
complete successful exact-commit merge-group run, including raw pgTAP.
The `test-full-shard` and `pgtap` jobs authenticate ghcr.io pulls with the
job's `GITHUB_TOKEN` and `packages: read` before non-reused tests; login failure
fails the job.
`install-proof` retains its Docker Hub service, which is pulled before steps run.

The non-required raw `pgtap` job follows the
[managed pgTAP on plain PostgreSQL plan](docs/platform/plans/neutral-postgres-pgtap.md).
`node scripts/public-ci-pgtap.mjs` applies the managed-compatibility adapter
`tests/postgres/managed-compat/supabase.sql` and replays the committed managed
chain in one transaction on the digest-pinned stock PostgreSQL 17 image, with
pgTAP, `pg_cron` and `pg_prove` from the checksum-pinned packages in
`config/ci-postgres-packages.json`. It then runs every shipped test with
`pg_prove` inside that container, using the retired Supabase CLI lane's argv
plus `--verbose`. It needs Docker, but neither the Supabase CLI nor npm
dependencies, and writes its TAP, catalog snapshot and environment fingerprint
to `.context/scratch/pgtap/`. The runner removes its own container on every
exit path it controls; an interrupted run leaves a disposable-labelled container
for the dead-owner sweep. Locally, `node scripts/pgtap-parity.mjs compare <left.log> <right.log>`
compares two TAP logs assertion by assertion and fails on any difference,
including a file present in one log only; `diff` compares two snapshots or
fingerprints. The runner takes one of the five planned `--sabotage` switches,
each of which must fail. The job is neither a required context nor a
native-review input.

See [Test scope and diagnostics](#test-scope-and-diagnostics) for selection,
sharding, discovery and test-author guidance.

The required `install-proof` job runs the shared package gate after both reference-profile builds, independently of the required `test` job in a separate checkout and installation. It discovers every publishable package from `config/openlup-packages.json` and its actual npm workspace, and refuses missing `api:check`, `ci:required` or `test:consumer` scripts before packing. The existing cold producer emits one current-set manifest. All API checks run before any package's `ci:required`, which receives the same verified manifest and exact checkout commit through `OPENLUP_PACK_MANIFEST` and `OPENLUP_PACK_COMMIT`. Cold preparation clears each workspace per target, so the API phase restores each package's built declarations and prerequisites through the existing build helper; it leaves the retained tarballs untouched and includes that cost in its timing. There is no missing-script skip or package-name routing table. A new module must supply installed-artifact consumer coverage, meaningful failure cases and its owning required batch; script declarations alone do not prove that those assertions are sound. Review checks that the batch actually invokes its consumer and preserves its required tests. Keep API checks out of that batch because the shared phase already runs them.

Dependency security has two boundaries. PR/merge-group admission refuses newly
selected vulnerable production dependencies against the exact comparison base;
an advisory affecting an unchanged dependency inherited from that base remains a
Dependabot alert, not a repository-wide merge freeze. Unknown dependency scope
is treated as production. Unavailable or incomplete audit data does not establish
PASS when dependency security inputs changed. This uses the existing
`install-proof` status; tests, API, lock, license, SBOM, pack and publish controls
remain required. Core's `ci:required` runs `release:admission`, which preserves
those controls without repeating the absolute live audit. Standalone `ci` and
`release:check` retain the absolute audit.

Publication is stricter: `packages:check --release-tag` / `--release-set` packing
runs a fresh full audit of the selected committed workspace dependency graph,
including internal prerequisites and their standalone locks, under the existing
zero-vulnerability budget. npm's production flags may conservatively include
shared dependencies also used by development tooling; optional peers absent
from the lock are not newly resolved. An audit failure retains no publication
artifacts. Manifest-only checks remain installation-free and do not audit.
The existing release gate also refuses a target with different pack/audit/publisher
control blobs from fetched main, before target code runs; older source is allowed
when these controls are unchanged. Historical release workflow definitions remain
pinned to their own commits.
The publishing workflow requires packing/audit from its current attempt; retry
all jobs after publication failure so the full audit runs again. Existing release
approvals, immutable version rules and protected credentials remain unchanged.

A module added to an existing distribution extends that package's consumer and
required batch; it does not need another npm workspace, runner or CI job.
Preserve the complete package proof and name the new module's behavior,
refusals and schema obligations. Grouping modules does not waive the
[internal dependency graph](docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#internal-boundaries-and-adapter-isolation)
or make multi-capability readiness available before its reviewed prerequisite.

For the planned foundation package and each later module that changes peers,
dependencies, public exports or the relevant import graph, extend the same
packed consumer with this cold proof before accepting the module candidate:

1. Install the actual core/platform tarballs and outbox when selected, with
   ordinary required dependencies and without optional provider SDKs. Verify
   their physical absence and independent resolution: no workspace links,
   repository or ancestor `node_modules` may supply them. `--omit=optional`
   alone does not prove isolation.
2. Classify the current export inventory and import every public nonadapter
   entry in a fresh process, without secrets, provider initialization or SQL.
   Compile its declarations in both NodeNext and Bundler mode without those
   SDKs; nonadapter declarations must not leak required SDK types.
3. Exercise the supported adapter's explicit, stable refusal naming the missing
   SDK or configuration, with no fetch, install or implicit fallback. Then
   install the selected SDK and run the adapter's actual consumer/conformance
   behavior and refusals without live provider access; mocking an import alone
   is insufficient.

Keep this in the existing required package gate. Cover the actual delta while
still importing all nonadapter exports after the change; final release proof
retains the complete required set. A failed cold consumer blocks candidate
acceptance even when unit tests pass. This specifies later foundation/module
proof, not a claim that today's core/outbox gate already tests platform.
Only schema-owning modules need database proof, including deterministic fresh
and upgrade/replay boundaries under the
[migration contract](docs/platform/DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories).

Core's required batch retains coverage, standalone types, documentation, release checks and its supplied-artifact consumer. Outbox's batch owns schema/SQL/replay against its installed tarball; its unit/factory/admission tests run once through the protected root selectors. The outbox workspace builds after core for root lint and test entrypoints. Package-local import checks still reject private subpaths, cross-directory escapes, aliases and other workspace dependencies; portable outbox production source also rejects provider SDKs. Missing artifacts or a required runtime refuse; there is no workspace fallback or DB skip. Only modules with SQL obligations need a database. Outbox's pinned job-owned PostgreSQL service is separate from raw pgTAP; see [the rail guide](packages/outbox/README.md) for ownership and proof limits.

For communications characterization and mail-boundary witness evidence, see the
[communications contract](docs/platform/CANONICAL_CONTRACTS.md#communications-import-compatibility)
and [witness ledger](docs/platform/plans/oss-m04-communications-triggers.md).

After committing and recording the required native reviews, run the normal full
local command set with `node scripts/verify-local.mjs` from the task worktree root.
Add `--pgtap` when the change reaches database inputs (including runtime, fixture,
configuration or harness changes), or when requesting that raw diagnostic.
The runner uses the commands below once: a single locked install, lint's package
prerequisites, both reference builds, shared package/API/coverage gates and one
`test:scoped`. Hosted shards, event-bound dependency comparison and receipt
admission remain hosted checks. This command neither creates a maintainer-local
stamp nor replaces an installed helper's requirements.

Each phase uses the existing native before/after review and candidate checks.
Where the optional resource broker is installed, a closed phase map selects its
existing coverage, build, typecheck and pgTAP profiles; task names never select
resources, and an unknown phase refuses before execution. Otherwise the native
wrapper runs directly. Logs retain exact commands, profiles, exits, timings and
the first root-worker observation; later synthetic fixture output cannot stand
in for it. Machine resource policy and explicit worker settings remain effective.
Build/package/root phases stay serial because they share generated outputs.
SSR output stays in a unique ignored worktree scratch directory so external npm
imports still resolve; cold package artifacts stay outside the checkout.
The first failure stops the run without an automatic retry or reuse of earlier
passes. The manual equivalents remain available:

```bash
npm ci

# Direct typecheck consumes built Core, Outbox and Platform declarations.
npm run pretest
# npm run lint and npm test also build all three through npm pre-scripts
# dco (needs no install): the commits your branch adds to origin/main
npm run check:dco-signoff -- "$(git rev-parse origin/main)" "$(git rev-parse HEAD)"
# typecheck
npm run lint
npm run oss:published-tree -- --typecheck
# install-proof (CI installs with: npm ci --prefer-offline --no-audit --fund=false)
npm run build
OPENLUP_REFERENCE_PROFILE=subscription OPENLUP_BUILD_OUT_DIR=dist-subscription \
  OPENLUP_SSR_OUT_DIR=dist-subscription-ssr npm run build:public-reference
# install-proof: package gates after both builds on a clean signed candidate
# Keep package gates before root tests locally: one checkout shares build outputs.
GATE_PACKS="$(mktemp -d)"
# Local SQL proof owns one ephemeral PostgreSQL container; CI passes its job service identity/port.
node --experimental-strip-types scripts/packages/required-package-gates.ts \
  --out "$GATE_PACKS" --expected-commit "$(git rev-parse HEAD)"
# test: omit bounded tooling fixtures whose inputs are untouched, including dirty files.
npm run test:scoped
# Hosted test-full-shard runs four parallel independent installations, each with:
# node scripts/ci-test-scope.mjs (OPENLUP_VITEST_EXCLUDE_FILE points to runner temp)
# npm test -- --shard=N/4 (N = 1, 2, 3, 4)
# self-check (needs no install)
npm run oss:published-tree -- --policy
npm run oss:published-tree -- --inventory
node scripts/public-ci-neutrality.mjs
node --experimental-strip-types packages/ui/smoke/neutrality.ts
# pgtap (Docker required; no Supabase CLI or npm install)
node scripts/public-ci-pgtap.mjs
# gitleaks 8.30.1, as CI pins it, over the checkout's history
gitleaks git . --config config/gitleaks.toml --redact --no-banner
```

The `prelint` and `pretest` scripts build Core, Outbox and Platform in dependency
order. Before direct typecheck or Vitest commands after install or package-source
edits, run `npm run pretest`; otherwise consumers may read stale `dist/` exports.

The [reviewed-forward PostgreSQL proof](tests/postgres/reviewedPortableCreation.test.ts) rejects landed pin drift before replay and tests byte selection for full and partial landings; [data and migrations](docs/platform/DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards) describes its catalog boundary.
See the [M09 forward owner](docs/platform/DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval) for managed correction finalization and parking. The fixture and registry do not install SQL.

For the managed pgTAP runner, prerequisites and proof limits, follow
[Test scope and diagnostics](#separate-db-package-and-coverage-proof).

The three `oss:published-tree` modes are distinct checks. `--policy` verifies
the public policy, catalogue, documentation ownership, generated navigation and
same-change documentation impact boundary; `--inventory` verifies the selected
tree, and `--typecheck` compares the preview's diagnostics with its tracked
compatibility debt. The source repository's aggregate typechecker is not part of
the projected command inventory and is not a substitute for `--typecheck`.
`check:dco-signoff` takes both range ends as full 40-character commit SHAs,
hence `git rev-parse`: it refuses a short SHA or a ref name with exit code 2,
and exits 1 on a range that contains no commit. In a fork, use the remote that
tracks `openlup/openlup` in place of `origin`. The subscription profile build
writes `dist-subscription/` and `dist-subscription-ssr/`, which `.gitignore`
does not cover, so do not commit them.

The required root shard jobs fetch complete Git history so their
neutrality CLI falsifiers can read the exact pinned prior fixture blobs. This
preserves their selectors and refusal assertions while supplying the history
those assertions require.

The native review session binds the committed candidate to its fork point (or
`OPENLUP_STACK_BASE` pin), tree, intent and fresh reviewer reports. Stable
material finding IDs require closure; evidence expires 24 hours after the
earliest counted PASS report for the current candidate. Unchanged prepare
preserves evidence. Three repair cycles are automatic; `needs_owner` then
requires an owner decision recorded with `continue "<note>"`, adding three.
Follow [Regroup when work stops converging](#regroup-when-work-stops-converging).
`prepare --new` records a changed
intent or a rebase in the same append-only session history; findings, reviewers
and the repair count carry on. Only `continue` adds cycles. Put the
simplicity pre-check in the first review request as prose. See the
[native session interface](docs/platform/plans/autonomous-reviewed-delivery.md#native-session-interface).
A branch remains verifiable while main advances without changing its fork point.
Routine code needs one cold reviewer who confirms ordinary semantics; sensitive,
material or unknown changes require two. Paths and modes can raise that floor,
and semantic uncertainty requires two fresh reviews of the same candidate.
Run the focused
`scripts/agent-review-session.test.ts`, `scripts/agent-review-queue.test.ts` and
`scripts/agent-review-gate.test.ts` batch while changing that contract;
fixtures do not prove installed enforcement. Installed verification must refuse
workflow drift before expensive checks or replacement of prior logs, and acquire
an output lock scoped to the actual task worktree before running those checks.
An existing lock is refused without stealing it or disturbing another task's
checks; unrelated worktrees use the host broker's capacity limits. The required
six-job commands remain unchanged; exact-candidate review evidence may be reused
by pre-push, but this process adds no general test-result cache. The local
verification stamp records that one exact clean tree passed. Pre-push requires
it, and it never lets a check be skipped. Prove actual
CLI and hook refusal paths in two dogfooding passes, batch material repairs, and
repeat affected scenarios before claiming live activation.

Published Tree CI also accepts `merge_group.checks_requested`. The six mechanical
jobs run against the queue's actual group checkout. DCO checks the complete
event-base-to-group range, including the synthetic tip; missing sign-off fails
without an exemption. Documentation impact uses the event's exact group base,
head, ref and tree, rather than inferring a PR head or using a stale local base.
A no-impact trailer binds the change and its owner, not the owner section's
prose or the base commit, so it stays valid in a group whose base moved for
unrelated reasons, including an edit of that section. A
pull-request checkout is identified by `GITHUB_SHA` and its exact event base and
head parents; the payload's `merge_commit_sha` is not compared, because a
`synchronize` payload can carry a lagging value.
The local verification mirror must match these workflow commands before final
delivery. A workflow change needs its separately authorized mirror update; focused
tests cannot replace that final gate or stamp. The mirror runs raw diagnostics
only on request, or pgTAP alone when the range reaches database inputs.

**When the job runs.** The `native-review` job runs when the repository
variable `OPENLUP_NATIVE_QUEUE` is `enabled`. At the
[dated inspection](docs/platform/DEVELOPMENT_AND_RELEASE.md#reading-results-and-recovering),
the variable was enabled and the ruleset required the context. Changing either
remains a separate settings action. A skipped job is not evidence of admission.

The job runs after all six actual mechanical successes and waits at most twenty
minutes for a receipt.

The optional `Queue Handoff` workflow is a completion action, not another
required check. It reuses this admission reader once, after the seven source
contexts succeeded, and inserts only a still-armed exact head. Its trusted
default-branch execution, isolated App identity and refusal of automatic requeue
are described under [Merge queue](#merge-queue); it does not change the source
or group command set, reviewer floor, receipt expiry or recovery budget.

**Receipt admission.** A pull-request run accepts a summary receipt for its PR
number and exact reviewed head and tree. One receipt covers every run and
attempt of that head while the review is current. A merge-group run accepts it
only when the source review carries over, as defined below. Missing, stale,
incomplete or mismatched evidence fails.

After fresh native source reviews and a passing local `verify`, the supervisor
posts the receipt as a PR comment as soon as the pull request is open and ready:

```bash
node scripts/agent-review-session.mjs receipt "$PR" | gh pr comment "$PR" --body-file -
```

Posting is a GitHub write within the task's delivery authority. Receipt generation
only prints the comment body. It contains the marker
`<!-- openlup-native-review-receipt v2 -->` and a fenced JSON summary with
`pr`, `base`, `head`, `tree`, `risk`, `reviewers`, `verdict`, `expires` and
`sessionDigest`; it carries no full session history.

The trusted-main `agent-review-queue.mjs wait` accepts receipt comments from
a user with write, maintain or admin permission and selects the newest valid
receipt for the live PR head. It checks repository permission rather than public
organization membership, caches each login's result for the wait, and refuses
bots and failed permission lookups. It fetches source objects with `transfer.fsckObjects=true`,
recomputes the tree and reviewer floor from the changed paths and modes, and
checks the base and expiry. Git runs through `/usr/bin/git` with
`PATH=/usr/bin:/bin`. The receipt base must equal the single fork point of the
reviewed head and actual main. Receipts have no separate stack-pin field: an
exact pinned predecessor landing becomes that fork point and preserves review;
an older landed ancestor is refused. A new head needs new review and a new receipt.

A source review carries over to a merge group when either:
- the group tree equals the reviewed tree; or
- the group is exactly the reviewed change on its queue base, which admission
  checks with `git merge-tree`, and the base's net change since the reviewed
  base touches neither the change's paths nor the admission, identity-binding,
  dependency and migration machinery (`.github/`, the review scripts, the
  identity fence, package manifests and lockfiles, `db/platform/migrations/`,
  `supabase/migrations/` and the platform migration manifest). Other check
  configuration is not on this list; the group's mechanical checks run with it.
  A moved `packages/<name>/package.json` does not block carry-over when main's
  and the change's edits to it only add new, disjoint subpath `exports` keys,
  preserve existing values with order-sensitive comparison, and leave every
  other key unchanged. The merged manifest must preserve those values and contain
  exactly both additions; root manifests and lockfiles still block.

Then the source receipt admits the group without another receipt or live session.
The six mechanical checks on the group tree cover behavioural interaction.
Otherwise admission rejects the group with "merge main and re-review": merge
`main` into the source branch, commit, obtain fresh review and post a new receipt.
There is no separate integration-review receipt route.

The supervisor follows actual admission in the same logical task; the maintainer
does not move prompts or reports. A receipt timeout needs submission or expiry
recovery, as [Merge queue](#merge-queue) describes. Freshness is checked at
admission, not guaranteed at the later merge; same-name checks from a malicious
writer remain outside this process-evidence boundary.

The experimental invoicing module adds an isolated row to the existing platform
module graph, with a type-only browser contracts entry and no module edges.
Its installed cold-consumer producer exercises default-off and explicit provider
selection from the packed artifact and exercises typed native host/store refusals
and offline adapter conformance. Declaration compilation covers the native-port
factory and conformance helper in both NodeNext and Bundler modes. Per-seam
`Record<RequiredKeys, string>` checks cover all 14 pinned-SQL store seams, including
union-arm evidence and explicitly local handling. A CI-run falsifier adds a required
field to a packed declaration and requires both the NodeNext and Bundler compiles
to reject it. The existing
package selection, boundary tests, API reports,
AST rules and required verification routes remain binding; this contract step
adds no separate runner or provider-access requirement.

The experimental account/support module appends an isolated module-graph row
with type-only browser contracts. R1 introduces no cross-module edges. Its package tests
cover unchanged account-read diagnostics, exact injected read delegation,
null/thrown refusals and browser bundling. The port-fit witness executes TypeScript
semantic checking of local owner-type equality and real-driver assignability;
Vitest's erased type assertions alone would not detect drift. The installed cold
consumer invokes the packed read facade on success, null and original thrown
refusal paths and rejects an invalid typed request. The reference binding test
uses the existing customer owner ports. These checks do not claim account
aggregate, command execution, managed/native parity or release acceptance; later
work is tracked in the [M12 design](docs/platform/plans/oss-m12-account-support.md).

R2's read extraction uses only the commerce, shipping and invoicing public server
entries, plus commerce/invoicing type entries. Its compiler-backed equality proof
lives in `accountReadModels.test.ts` for packaged owners and
`m12SupportReadBinding.test.ts` for reference-source owners. Browser-safe subsets
exclude private line/profile fields; method/provider vocabulary is host selected.
Its cases include complete-catalogue PostgreSQL reads and installed-consumer proof
using the existing packed fixture. Each independent installed scenario reports its
own observed/expected result and executed case while sharing a script invocation
per module mode; one scenario failure must not hide the others. The real PostgreSQL cases fail when Docker is
unavailable; missing proof cannot be reported as a skip-pass.
Retain the current owner tests for delivery alignment, renewal engines, PDF
validation and control-snapshot translation rather than duplicating those engines.
The source routes remain unchanged pending P7.

### Commands and lint rules

The platform module graph declares browser marketing with an isolated contracts
entry and no cross-module platform edges. Its runtime entry may forward the
existing public core research export; contracts forward only core types and
local DTO shapes, including reachable acquisition ports, portable prelaunch
types and shared organization/contact/legal/privacy content slots. Retired admission schemas are excluded from both browser entries. The
separate `marketing/server` entry admits marketing and identity-contract values,
plus HTTP, BFF, marketing-contract and communications-contract type
edges. Its two PostgreSQL
files alone admit the existing pg peer and are exported through
`marketing/server/postgres`. Package boundary checks validate that graph with the
other modules and prevent the handler entry from reaching PostgreSQL adapters or
`pg`. The installed consumer imports and compiles `marketing/server` without
optional peers, exercising a historical count and a conflict refusal through
injected bindings. It proves the `/postgres` missing-peer import refusal before
selecting pg, then checks the adapter factories and their connection refusal.

Marketing analytics facts use the same isolated runtime/contracts graph. The
reference keeps host policy and wire literals in thin bindings; its purchase
projection has a frozen base transcript. Neutral package witnesses cover inert
analytics, route refusal/sanitization, paid allocation, consent chronology and
independent sink admission. Local acceptance booleans do not prove delivery.

The analytics context witness in `packages/platform/test/marketing/` exercises
the server factory with synthetic persistence, capability and identity bindings.
It preserves consent capability issuance/replacement, strict admission and
verified-subject enrollment, with a missing-store refusal at the injected seam.
The `./marketing/server` release surface selects it, and root discovery includes
it with the package tests. It needs no reference route or live persistence;
telemetry context failure never gates commerce and `active` proves only a local
context fact.

The marketing privacy graph test admits the obligation schema only through
`identity/contracts/index.js`; both value and type imports of `identity/index.js`
and internal-file shortcuts refuse. Contributor ports and return types are local
structural interfaces using identity contract types. The
existing installed server witness also checks both privacy factories and
default-off null callables without invoking an owner or creating a case. Its
strict declaration compilation covers the privacy and acquisition ports without
selecting identity's server type closure; a runtime import without `pg` alone cannot prove
declaration independence. Keep these proofs distinct and retain the optional-peer
absence assertions. K5 contributor, binding and composition witnesses exercise
unavailable partial ownership, identity refusal/veto ordering, rollback and
receipt replay rather than duplicating the provider erasure worker.

The existing marketing contract checker also compiles exact structural equality
checks between both privacy factory results and identity's `PersonalDataContributor`.
It uses the platform's ES2022 library declarations to check imported production
source while retaining an ES2020 target and adding no newer test APIs. This extends
an existing case; K5 remains 16 cases across contributor, binding and composition.

The complete projected root command inventory is `build`,
`build:public-reference`, `build:public-reference:client`,
`build:public-reference:prerender`, `build:public-reference:ssr`,
`check:dco-signoff`, `guard:client-secret-boundary`,
`guard:public-reference-site-routes`, `lint`, `prelint`,
`oss:published-tree`, `packages:check`, `release:bump`, `pretest`, `test`, and `test:scoped`.
This reclassifies the complete current root script inventory; all commands are
public, with `test:scoped` as the local wrapper around the unchanged `test` command.
`npm run build` is the public build truth; its public-reference subcommands and
guards are internal links in that bounded chain. Published Tree CI invokes the
build, sharded required root tests, DCO check, and publication checks from this inventory.
Adding or renaming any source package command requires reclassifying the whole
source command-name inventory before a new preview can be materialized.

Keep historical source/config backups outside the checkout's tool traversal.
Git-ignore alone prevents neither executable `eslint.config.*` discovery nor
linting an archived test import. Preserve archival byte/hash provenance in task
evidence; retain the scope and semantics of real test fixtures.

`npm run lint` runs ESLint over the tree, including the import boundaries in
[eslint.config.js](eslint.config.js): a package under `packages/` imports
nothing outside its own directory, other code reaches a package only through
the subpaths its `exports` declare, and domain code under `src/domains` and
`server/domains` imports no configured provider SDK and no adapter,
infrastructure, runtime or route code; the config exempts domain tests.
Non-test production source under `packages/core/src` and `packages/ui/src`
also imports none of the provider SDKs listed in the config. Package tests
retain their package isolation even when composing with a provider.
Provider composition exemptions use `*.test.<extension>` and
`*.testFixtures.ts`, matching the existing test convention.
The boundaries cover static imports and re-exports, literal or plain-template
`import()`, type imports, and literal or plain-template `require()` and
`module.require()` calls; they do not resolve aliases or stored specifiers.
An exact alias in the
root `package.json` `imports` map counts as such code when any path it can
resolve to lies in one of those directories, including a path selected by a
condition, since Node allows a condition object as a target. A subpath pattern
alias such as `#name/*` is not matched as a pattern. Published Tree CI runs lint
in the `typecheck` job.

The [import-boundary test matrix](scripts/packages/eslint-import-map.test.ts)
reuses one linter per loaded configuration across that configuration's samples.
Each import-map scenario loads its own configuration. Both boundary helpers
reject parser failures and unmatched files before checking the expected rule;
syntax tables exercise every supported loader form for each owning rule family.
Separate path tables exercise package names, path spellings and depth boundaries
with one canonical load. This preserves the syntax and path obligations without
repeating their full Cartesian product. Type-only edges keep both accepted type
loads and refused value loads. The platform package source proof remains: its
provider allowlist and member-call loaders cover cases outside ESLint's current
selectors, so that check cannot yet be removed as duplicate coverage.

`npm run lint` first checks file-leading blank-line suppressions with
`scripts/ast-grep/check-filewide-ignore.mjs`; this check cannot be suppressed
by an ast-grep directive. It then scans with the structural rules in
`scripts/ast-grep/rules` (configured by `sgconfig.yml`), refuses bare or unused
suppressions, runs the cases in `scripts/ast-grep/rule-tests`, then runs ESLint.
These rules catch ordinary mistakes; review handles deliberate evasion.
ESLint's boundary rules check import paths; the structural rules check calls,
reads and literals. A non-test `.ts` or `.tsx` module under `server/bff` reaches
the database only through a port or the actor data gateway:
it does not load the database client SDK through an import or re-export, `import
= require`, or an `import()`, `require()` or `createRequire()(...)` call whose
argument names it, and does not reference `createClient`, `.from` or `.rpc`,
whether by name, as a member, through a string index, through direct object
destructuring (including aliases and defaults), through `.call`, `.apply`
or `.bind`, or behind parentheses, a comma operator, a type or non-null
assertion or a prefix `await`, `void`, `!` or `typeof` (standard static
`Array`, `Buffer` and typed-array `.from` methods excepted). Client-factory
references include shorthand object values and runtime class names. A pure
alias/interface name by itself, or ordinary string data, is not a client-factory
value. Direct
`logger` or `console` diagnostics may print the SDK package name; a stored
path remains blocked because it can be used for a module load. Domain code under
`server/domains`, `src/domains` and `packages/core/src` reads no environment
variable: it has no `.env` or `["env"]`
access, and no destructuring of `env` in a declaration, parameter default,
assignment or loop head, on an expression that involves `process` or
`import.meta`, however that expression is wrapped or asserted, and no import,
`require()`, `createRequire()(...)`, dynamic import or re-export of
`node:process`; the rule does not follow a value through an intermediate
variable. The same domain code contains no two-letter uppercase string, template
or template-type literal in any position. Such literals can introduce country
or region policy; syntax alone does not establish their meaning. Test files are
exempt, and so are fixtures and test helpers from the country rule. Files that
predate a rule are listed in its `ignores`: delete an entry when its file is
fixed and never add one. A justified exception, such as a genuine non-country
code or a genuine non-database `from` member or destructuring key, is an
`// ast-grep-ignore: <rule-id>` comment on the line before the code,
with the reason in a comment above it. The comment names the exact rule id,
which in a `.tsx` file is the `-tsx` variant, such as
`domain-no-country-literals-tsx`. A new rule states the platform rule it
enforces, blocks only at zero findings, and has at least one valid and one
invalid case. A first-line `ast-grep-ignore` followed by a blank line is
file-wide and is rejected, including BOM-prefixed or triple-slash comments,
even when it names a rule. A line exception must
sit directly above its target; an unused exception is rejected. After each edit,
run a focused scan with both suppression checks; replace the example path with
your changed files:

```sh
npx --no -- ast-grep scan --error=no-suppress-all \
  --error=unused-suppression server/bff/admin/platform/me.ts
```

Before committing, run `npm run lint` for the independent file-wide-ignore
check, whole-tree scan, rule tests and ESLint. Keep `--no --`: without it npx can
fetch an unrelated registry package of the same name when the local binary is missing.
While iterating, `npx --no -- ast-grep run --pattern '<code pattern>' --lang ts`
lists every structural match, and `--rewrite '<replacement>' --update-all`
applies a mechanical edit; call the binary `ast-grep`, because `sg` is also a
system command on Linux.

`portable-no-industry-contracts` and its TSX variant guard the clean portable
source in every package's `src` (`packages/*/src`), so a newly imported module
package is checked from its first commit. Explicit `pet`, `pets`,
`dog`, `dogs`, `cat` or `cats` components in identifiers, property/type names,
static declaration/access keys and literal types belong in adopter code, not generic
contracts. For example, `petId`, `dogWeightKg`, `CatProfile` and
`Record<"petId", string>` fail. `watchdog`, `dogfoodEvidence`, comments and
ordinary runtime string values pass, as does forwarding opaque
`Record<string, unknown>` extension data. Tests and fixtures are exempt. The
rule covers TS/TSX syntax; it does not infer types, track aliases, inspect
arbitrary payload values, or classify legacy application schemas. Provider
isolation remains an ESLint responsibility. The existing packed-core audit
also refuses the configured provider content, including the Vercel SDK
namespace, in actual package artifacts. These checks add no command or CI job.

### Test scope and diagnostics

The existing qualified target/separate-restore witness connects the native G17
observation host binding through its actual restricted runtime login. Setup
prepares an already-submitted request; recovery read/ACK, observation/status,
replay and conflicting-ID refusal use R. See [Compatibility lifecycle](docs/platform/DATA_AND_MIGRATIONS.md#compatibility-lifecycle). No new grant, install shape or provider qualification is added.

Risk's unchanged import uses `packages/platform/test/risk/` for schemas,
assessor, adapter and browser boundaries, and
`tests/postgres/riskControl.conformance.test.ts` for seven scenarios on each
existing SQL rail. The fixture applies the hash-checked native prefix or frozen
managed baseline, exercises separate non-superuser runtime/browser sessions,
and runs the existing `supabase/tests/risk_blocklist_test.sql` pgTAP assertions.
Its native grants are fixture composition only. The shared cold-consumer harness
executes packed risk assessment and missing-payment refusal without optional
runtime peers; this preliminary trial does not establish adopter acceptance.


Use the pinned Node version in [.nvmrc](.nvmrc), npm 11.19.0 and the committed lockfile in your task worktree. Start with the affected behavior, then complete [required and raw checks](#required-and-raw-checks). Focused tests do not replace required package, lint, policy or verification gates.

#### Run and inspect

After `npm ci`, use:

```sh
# Builds Core, Outbox and Platform, then runs the affected root tests.
npm test -- server/domains/subscription

# Ordinary local root gate: excludes only eligible untouched tooling fixtures.
npm run test:scoped

# Unfiltered root suite. Ensure no exclusion file is inherited.
npm test

# Discovery only; direct Vitest does not build package prerequisites.
npm run pretest
npx --no -- vitest list --filesOnly
npx --no -- vitest list --filesOnly --project=node server/domains/subscription

# Native review changes: pure session/hosted tables plus real Git witnesses.
npm test -- scripts/agent-review-session.test.ts scripts/agent-review-queue.test.ts scripts/agent-review-gate.test.ts

# Package command changes: detect stale synthetic command expectations first.
npm test -- scripts/source-preview-release.test.ts -t "builds its synthetic workspace manifests with the pinned public execution surfaces"

# Packing/release changes: exercise the affected fixture and refusal boundaries.
npm test -- scripts/packages/required-package-gates.test.ts scripts/packages/set-release.test.ts

# Separate Core suite; includes coverage, API/docs/release and packed consumer.
npm --workspace @openlup/core run ci
```

Unset `OPENLUP_VITEST_EXCLUDE_FILE` when requesting an unfiltered run. Outbox and Platform tests also run locally with `npm --workspace @openlup/outbox test` or `npm --workspace @openlup/platform test` after building prerequisites; their package configs use Node and do not inherit root setup. Their installed consumers belong to the shared package gate, not that local command.

Disposable PostgreSQL fixtures mount `/var/lib/postgresql/data` as `tmpfs`.
This covers the PostgreSQL image's declared data volume before container
creation, so an interrupted worker cannot leave an anonymous data volume.
Normal and failed-start teardown still removes the owned container with
`docker rm -f -v`; other anonymous mounts are removed too. A worker killed
with `SIGKILL` can still leave a container, including one in `Created` state:
temporary data storage prevents the volume leak. Disposable creators also label
the owner PID, host-clock start epoch, short hostname and (on Linux) PID namespace
with `dev.disposable.*`, plus the fresh test run ID. A same-host sweep reclaims
only `dev.disposable=1` containers at least 60 seconds old whose owner is gone
or whose PID start differs by more than two seconds; uncertainty keeps them.
`OPENLUP_DISPOSABLE_REAP=remove` (default), `report` or `off` controls the
once-per-run host sweep; `CI=true` disables that sweep. Teardown and the wrapper
sweep only their own run selector under the same liveness rule, including on CI,
without the age floor: an exited helper child's container goes at teardown, and
after its Vitest child exits the wrapper removes one started just before Ctrl-C.
Nested runs get independent IDs. Unlabeled containers are never removed.
The container-helper regression checks exact owned container and volume IDs
for normal teardown and port-bind failure, without relying on global counts.

For the Node scheduler drain boundary, run
`npm test -- --run tests/postgres/nodeHostRuntimeDrain.test.ts`. Its dedicated
PostgreSQL sessions prove same-session exclusion and replacement-host admission
only after the original callback drains. Missing Docker or PostgreSQL fails the
witness rather than skipping it; this focused run does not replace the required
package, coverage or full verification gates.

Hosted `test-full-shard` jobs run `npm test -- --shard=N/4` in four independent installations. They apply the same event-based selection before sharding. Required `test` accepts only success from the whole matrix; failure, cancellation or a skipped shard job refuses. There is no `test:required` script or separate `test-full` job. A successful shard can still report individually skipped cases; record missing proof.

#### Choose a location and proof

Acquisition server characterization belongs under
`packages/platform/test/marketing/server/`. The cross-boundary
`tests/postgres/acquisitionEvidenceParity.test.ts` witness uses the existing
container helper, applies the hash-checked migration-manifest prefix and calls
package ports through a login granted only the acquisition runtime role. Docker
absence throws as missing proof. The fixture owner is used only for setup, state
inspection and the donor's append-only trigger proof. Port operations and
separate SQL privilege-denial assertions use the runtime role, retaining all 11
cases. The reference retains retirement, admin-auth binding and notification-copy
checks.

| Test | Placement and execution |
|---|---|
| Domain, server, API, MCP or tooling logic/contract | Adjacent descriptive `.test.ts`; root Node project discovers `api`, `mcp`, `scripts`, `server` and `src`. |
| Browser interaction | `src` `.test.tsx`; `.test.ts` under `src/components`, `src/hooks` or `src/test` also uses jsdom. A Node-project .ts test requiring DOM must declare `@vitest-environment jsdom`. |
| Package unit/characterization | `packages/outbox/test` and `packages/platform/test` are root-discovered. Core `smoke/` and `test/` use its separate Node config and required Core batch. |
| Cross-boundary/DB | Existing `tests/platform`, `tests/postgres` or `tests/golden-master` Node roots. The [additional cross-boundary DOM root](vitest.config.ts) uses jsdom for `.test.tsx`. Do not assume every `tests/` directory is collected. |
| Durable SQL behavior | `supabase/tests` for managed pgTAP; selected portable/installed DB conformance stays with its owning runner. |
| Browser journey | Explicit Playwright/profile runner; not root Vitest. Follow the [subscription](docs/platform/SUBSCRIPTION_REFERENCE.md) or [identity](docs/platform/IDENTITY.md) owner. |

The [root config](vitest.config.ts) is the exact discovery inventory: it accepts `.test.ts`/`.spec.ts` in its Node roots, and `.test.tsx`/`.spec.tsx` in its DOM roots. Checkout helper discovery is narrowly `tests/preview/checkout/helpers/**/*.test.ts`. Prefer `.test` names consistent with adjacent files and boundary rules; in `packages/outbox/test` and `packages/platform/test` use `.test.ts` only, because their package-local configs collect only that suffix. Verify a new file appears with `list --filesOnly`; placement alone is not execution evidence.

Use the smallest proof that can detect the failure:

| Proof | What it must detect |
| --- | --- |
| Unit table | Incorrect decision or edge case. |
| Contract/conformance | Broken success, refusal or boundary translation. |
| Characterization/golden/effect transcript | Changed observable behavior. |
| Real Git/process witness | Incorrect CLI, object, environment, exit or workflow refusal behavior. |
| SQL | Broken role, constraint, transaction, concurrency or replay behavior. |
| Packed consumer | Broken installed artifact or workspace leakage. |
| Browser journey | Broken interaction in the selected mounted application. |

Extend an existing meaningful case first; add a test for changed behavior, a discovered defect, or a required contract/refusal/replay boundary. Migrations, status mappings and idempotency rules require failure/replay regressions. Demonstrate adapter capabilities and refusals without live providers. Preserve the unchanged [adopter characterization witness](#contribute-existing-adopter-code-then-refactor) during refactoring. Do not test private implementation shape or add a harness solely to test the harness.

#### Sufficient evidence and material test gaps

Before counted review, clarify the approved behavior, its failure boundary and
the smallest discriminating executed proof in the existing task record. A few
sentences or a small table suffice; this is not an inventory of every branch or
another audit. The review brief links to that record and states scope/exclusions.

An actual reachable defect violating the accepted contract blocks regardless of
test presence. A material proof gap identifies a required, unproved behavior class
or boundary, a credible mistake mechanism at the changed boundary, and why all
relevant executed proofs fail to distinguish it. Include scenarios requiring
refusal. A test's existence, name or coverage percentage alone proves none of this.
The map does not waive a newly discovered required boundary or a mandatory gate.

Mutation is a bounded way to challenge that proof, not a completeness target.
Reachability and nonequivalence are necessary but insufficient for a blocking
mutation finding. Additional variants within an already discriminated class are
advice unless they expose such a mechanism or a separate obligation. For example,
equal document/predecessor IDs in every fixture can hide an argument swap when the
contract permits different IDs; one distinct case may resolve it. A swap where
the contract requires equality, or arbitrary new amount-specific corruption, does
not itself justify an endless series of cases. Missing required replay proof
remains material if removing its protection could create a second fiscal effect.

Choose proof by the boundary: a real-DB table can test translation and durable
effects, but a superuser does not prove role restrictions, sequential rows do not
prove concurrency, and final DB state may miss duplicate external effects. Keep
required role, transaction, concurrency, installed-artifact and fault witnesses.
Changing proof technique within the approved requirement is autonomous; weakening
that requirement or changing a characterization witness's meaning needs its
applicable owner decision. Never rewrite acceptance merely to obtain PASS.

Keep executable tests tied to a current offered contract, installed safety
boundary or selected reference behaviour. Historical migration spellings,
withheld commands, deployment inventory counts and adopter presentation are not
platform acceptance requirements. Removing an obsolete assertion requires its
ended duty or equivalent surviving proof; a similar test name is insufficient.
Unmounted UI may defer interaction proof until that exact UI is selected, while
installed authorization, money, persistence and replay controls remain tested.
Retire dormant scenarios from the source tree rather than adding skips or
runner exclusions; reintroduce neutral scenarios when their contract is selected.
Remove their uncalled helper modules with them. Test a supplied tool's actual
entrypoint or consumer; a helper retained solely for a withheld wrapper does not
create a public acceptance obligation. SQL asset and documentation checks preserve
readability, valid destinations and current behavior, rather than exact comment
wording or a requirement that a useful link appear only once.

#### Keep fixtures deterministic and work fast

Reuse [root setup](src/test/setup.ts), [Git environment scrub](tests/setup/scrub-git-env.ts), [render providers](src/test/render.tsx) and existing owner-local fixtures when applicable. Use synthetic, profile-valid inputs. Inject time, randomness and external ports; restore timers, environment stubs, module state, mocks and resources you change. Tests must not depend on file order, another test or a shard's membership.

Prefer table-driven pure cases and the minimum real boundary witnesses that prove the requirement. Retain real Git/process/DB witnesses where the requirement depends on actual process behavior, SQL permissions, transactions or concurrency. Do not replace those witnesses with mocks. Use temporary repositories with explicit identity, bounded child processes and owned cleanup; never mutate the contributor's repository or use ambient/live services. Follow [database fixture rules](docs/platform/DATA_AND_MIGRATIONS.md#database-test-fixtures-and-witnesses).

The [disposable PostgreSQL helper](tests/helpers/postgresContainer.ts) removes its
explicitly named test container together with its anonymous data volumes on
pre-start cleanup, failed startup and final removal. PostgreSQL images declare
those volumes even without an explicit mount; removing only the container leaves
them behind. Docker retains named volumes with this operation. The
[cleanup regression](tests/postgres/postgresContainerCleanup.test.ts) uses its own
unique containers and volumes against a real Docker daemon, checks bind-conflict
retry and other startup errors, and preserves a named volume and another
container. Cross-run reclamation is limited to the labelled dead-owner contract
above; it never authorizes pruning unlabeled resources or a live owner's stack.

Root test/hook defaults are 10 seconds, or 30 with coverage; externally supplied duration pins may raise them. These are deadlines, not expected runtimes or whole-file budgets. Process spawning, repeated tree copies, compilers, npm packs/installs, containers and intentional deadline waits are likely costs. Measure expensive additions and record command, revision, environment, workers and observed duration in existing task evidence. Simplify repeated setup or decision matrices before raising a timeout; give necessary integration work an explicit bounded deadline sized for hosted runners. Preserve `retry: 0` and required proof.

To find optimisation targets, read the per-file durations Vitest prints in a hosted shard log (`✓ <file> (<n> tests) <ms>`) or locally with `npm test -- <path>`, and rank by file time. On 2026-10-19 the slowest root files were repository-tooling tests (`scripts/packages/outbox-consumer-proof.test.ts`, `scripts/source-preview-release.test.ts`, `scripts/public-ci-neutrality.test.ts`), each 40–80 s; slim one by moving decisions into table-driven cases and keeping only the real-process witnesses its requirement needs.

Ordinary local workers default to 37.5% of cores (6 of 16 on the measured
host) from the config; `--maxWorkers` also accepts a percentage. Vitest reads
the `VITEST_MAX_WORKERS` environment variable as an integer and lets it override
both, so the `npm test` wrapper first resolves any percentage in it, its own or
the caller's, the way Vitest resolves a config percentage: available cores times
the whole-number part of the percent, rounded, at least one. Through the
wrapper, coverage defaults to 50% of cores, or 40% under contention; a direct
`vitest --coverage` run uses the 37.5% config default. Plain local runs inside `verify-command` or an active resource
broker instead default to at most four workers and the host's core count. A
positive broker CPU-token count further caps workers at one less than that
count, with a minimum of one, leaving capacity for the main process and child
compilers. Explicit `VITEST_MAX_WORKERS` or `OPENLUP_VITEST_MAX_WORKERS` pins take
precedence. The wrapper logs this verification default. CI scheduling and
coverage retain their existing policies. Use `VITEST_MAX_WORKERS` for focused
reproduction; do not skip assertions or introduce a speed gate to make a test green.

Real package-size witnesses run separately for each package (30 seconds) and
browser entry (15 seconds), so adding modules does not multiply one case's
work. Their Git, npm-pack and browser-bundler children are bounded at 5, 20 and
10 seconds respectively. The two-bundle growth refusal has a 25-second case
budget. The source-release stale/fresh/dirty/changed witness retains its real
CLI state transitions in one 60-second case, with 10-second fixture Git and CLI
bounds. These limits enclose the necessary child work; they do not alter size,
release or refusal assertions or enable retries.

#### Extend tooling selection conservatively

[ci-test-scope.mjs](scripts/ci-test-scope.mjs) contains eligible bounded tooling rows. **New and unlisted tests always run. A new tooling test does not need a row.** Add one only when skipping untouched inputs saves useful work and its complete dependency closure is understood.

Declare every actual nonshared repository input the test or imported code reads: source, configuration, manifests, documentation, inventory, package outputs and reference wiring. Use an exact path or a directory prefix ending in `/`; no globs. Fixture strings are not reads of the corresponding real repository files. Prefer a broader prefix to incomplete precision.

The Outbox companion reads `config/ci-images.json` through its image helper;
image-pin-only changes therefore retain its real interruption and refusal
witnesses even when unrelated bounded tooling fixtures are excluded.

All rows already share `scripts/`, `tests/setup/`, `src/test/` and `src/checkout/machine/commerceRequestCache.ts`. Every root file and every dot-prefixed segment anywhere also runs everything. Package rows conservatively include `packages/`. Repository-wide inventory/policy/neutrality/removal scans stay unlisted. When a row gains a new read, extend it; when its closure becomes uncertain or tree-wide, remove it.

Review input completeness against the actual test/import closure. Extend [scope falsifiers](scripts/ci-test-scope.test.ts) for the new dependency behavior; row-derived tests alone cannot discover an omitted input. Preserve shared triggers, rename/deletion coverage, identical shard selection and errors selecting everything.

PR/group scope uses the merge-base with the event's exact base. Local scope uses `origin/main` plus committed, staged, unstaged and untracked paths. For a deliberate alternative local base:

```sh
(
  scope_file=$(mktemp) || exit 1
  trap 'rm -f "$scope_file"' EXIT
  export OPENLUP_VITEST_EXCLUDE_FILE="$scope_file"
  node scripts/ci-test-scope.mjs --base <ref> &&
    npm test
)
```

Unknown events, malformed metadata or unavailable Git history exclude nothing. Selection is an optimization, never a failure waiver. Keep the project-level exact-path seam; root `--exclude` cannot replace it.

#### Separate DB, package and coverage proof

[Required checks](#required-and-raw-checks) owns the full command sequence. `install-proof` builds both profiles and runs [shared package gates](scripts/packages/required-package-gates.ts): cold-pack the publishable inventory once, all API checks first, then each `ci:required` with verified manifest/commit. Keep local package preparation before root tests because generated outputs are shared. New modules extend the owning package's consumer and required batch; do not add a workspace or job without a separate need.

Core required coverage is V8: statements/lines 80%, branches 65%, functions 75%, plus no nonempty production file with zero covered lines. Root config has percentage thresholds when explicitly running coverage; public CI does not run root coverage or its separate no-zero helper. Outbox/Platform have no separate percentage gate. Keep installed-artifact and meaningful failure assertions; percentages do not replace them.

Root tests include required disposable Docker/PostgreSQL proofs. Some older tests explicitly skip when Docker is absent; a skip does not prove that boundary. Installed Outbox/Platform consumers require their owned database and refuse missing infrastructure. For managed SQL use `node scripts/public-ci-pgtap.mjs` with Docker; it needs neither the Supabase CLI nor npm dependencies. It validates committed migration bytes, starts one disposable stock PostgreSQL 17 container with the checksum-pinned pgTAP, `pg_cron` and `pg_prove` packages and the managed-compatibility adapter, replays baseline/forwards with public prerequisites, runs all supplied SQL tests and removes only its own container. Commit migration candidates before this runner; it refuses dirty migration bytes. It never links a hosted database or installs application seed data; it copies the shipped SQL tests unchanged. Replay uses a disposable diagnostic owner with closed default grants, so this profile is not production installer authority or a managed-host certification.

pgTAP remains a raw diagnostic, while root `test` and package `install-proof` are required. Triage actual exits, failed/aborted files, skipped prerequisites and new failures against the exact base; [historical diagnostic evidence](docs/platform/plans/public-ci-known-red.md) grants no waiver. Neither mocks, static SQL assertions, listing, a build nor a green aggregate proves an unexecuted DB/browser/provider obligation.

Local root coverage (`npm test -- --coverage <path>`) runs Vitest directly when
the host-local broker helper is absent, with the same arguments, environment
and coverage-summary handling as an already admitted run. A focused subset still
uses root percentage thresholds; it does not establish full-suite coverage.

Keep documentation falsifiers independently discoverable for routing, impact, bare-runtime CLI and bundle corruption; never import one test file from another. Disposable fixtures prove those refusals, not arbitrary prose meaning. Follow [lint rules](#commands-and-lint-rules), including valid/invalid cases for new ast-grep rules, and [documentation impact](docs/platform/DOCUMENTATION.md#impact). Fixtures still obey neutrality and secret-handling policy.

### Package, policy and release checks

The marketing cold-consumer witness imports both exact public subpaths without
optional peers, compiles their DTO, acquisition-port, research-port and content-slot
usage, checks core schema identity and refuses a deep import. Its marketing runtime
usage exercises JSON-LD serialization, graph deduplication and ordered head data;
synthetic package and reference adapter cases cover hostile script values,
contact/legal projections and host head commits. Root discovery includes the package's
marketing schema, type-equality and source/built browser graph tests. The
reference equivalence transcript pins pre-extraction outputs and ordered issues;
retained application contract suites remain part of the focused proof. Portable
prelaunch goldens preserve their own reference regexes, strictness, ordered issues
and coercing defaults. Compiler proof covers acquisition port signatures and
bidirectional fit of the extended reference case port to its base-equivalent shape.

Marketing smoke selection includes analytics defaults, route policy, purchase
facts, consent evidence and sink failure isolation. The installed consumer exercises
inert runtime imports and compiles structural recap/consent inputs plus a literal
host step union. Both complete browser graphs remain free of server imports,
and the contracts runtime stays empty. Reference purchase characterization pins
ordered refusals and both item-cap boundaries before and after rebinding.

`npm run packages:check -- --manifest-only` checks every `packages/*/package.json` against
[`config/openlup-packages.json`](config/openlup-packages.json), which lists each
package as released or as unreleased. A released package `packages/<name>` is
named `@openlup/<name>` and has its own `MAJOR.MINOR.PATCH` version, exact pins
to the current versions of other released `@openlup/*` packages, registry semver
ranges for every other dependency, and curated `exports`: no wildcard or
directory entries, and every target under `./dist/` except a `core-source`
target, which stays under `./src/`. It is either `private: true` or carries
exactly the public, provenance-backed publication settings and a `repository`
entry. Its `publishConfig.tag` stays `preview`, so only the release workflow's
explicit `--tag latest` moves `latest`. An unreleased package is always
`private: true`. A new package stays unreleased through its module's pull
requests and becomes publishable only in the module's final one, where the
reference application composes it, so a set never republishes a half-built
package.

`npm run packages:check` (also `--pack`, retained for existing callers) builds and packs each released package
into a temporary directory, from a package directory with no uncommitted
changes. Every packed file must be either a tracked file of that package, byte
for byte (the manifest included), or built output of a tracked non-test source.
Artifact checks enforce the per-package byte/file caps, content allowlist and
browser-entry budgets. Only `--release-set <version>` checks growth against the
last released baseline and requires explanations in the new set's changelog
section and release body, as described in
[Package artifact limits](.github/VERSIONING_AND_EOL.md#package-artifact-limits).
The privileged release job explicitly selects `--manifest-only`; its separate
unprivileged cold producer still checks every artifact before publication.
Every concrete `exports` target, including JavaScript, declarations and
`core-source`, must be present in the tarball. The core documentation check also
requires relative Markdown links in shipped files to target packed files, not
just files present in the source checkout.
Destination checks are conservative: unsupported boundaries, raw ampersands or
angle characters, Unicode whitespace and malformed percent encoding refuse with
an actionable error. Use literal punctuation or percent-encoded filenames and
ASCII whitespace before optional titles. This keeps ambiguous Markdown from
silently checking a different file.
It refuses source maps and source-map references, build-machine home paths, and
the operational coordinates the public detector knows. It prints each tarball's
integrity. `-- --out <dir>` implies `--pack`. It keeps each publishable
package's tarball in an empty directory, with a `packages-manifest.json` of
their versions and digests. `-- --release-tag openlup-<package>-v<version>`
packs only that publishable package and requires its manifest version to be
`<version>`. The command publishes nothing;
[Package releases](.github/VERSIONING_AND_EOL.md#package-releases) describes how
the protected release approval leads to direct OIDC publication.

For managed pgTAP execution and its prerequisites, follow
[Test scope and diagnostics](#separate-db-package-and-coverage-proof).

The self-check job runs the existing UI neutrality gate and a tree-wide ratchet
that reuses both that gate's patterns and the core source scanner. The initial
[`neutrality baseline`](config/openlup-neutrality-baseline.json) records the
counts on main at its full `sourceCommit`. Counts are pinned per exact path
(SHA-256 key) and category: a decrease elsewhere cannot pay for an increase.
Text files are scanned regardless of extension; binary files are inventoried.
The job also rejects baseline increases relative to the PR base/main push's
previous commit. For a first baseline, or to regenerate from main without
increasing debt, use `node scripts/public-ci-neutrality.mjs --write-baseline`.
After removing debt, lower the affected counts; never raise them.

The named **bounded debt C94 — M10 reviewed packet vocabulary** is the coordinator-approved
bounded recalibration for immutable managed SQL and its pinned registry COMMENT,
following the diagnostic-fixture debt treatment in #130. Its exact path/category
counts are documented in [Data and migrations](docs/platform/DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards).
This control change adds baseline keys only for the six existing managed fixtures
and that registry carrier; existing counts stay unchanged. Each landing PR
(P3b, P5, F17) adds only its own rail keys with the files and exact pinned counts.
Every present baseline key for an allowance path must match all its pinned
category counts exactly, including during regeneration; absent files cannot
justify new keys. `reviewedPinnedIntroductions` in the wrapper retains those 13 C94 paths and
15 tuples: six inert managed SQL fixtures, their six future
`supabase/migrations/` copies, and `config/reviewed-platform-forwards.json`.
M14 adds exactly one unchanged package SQL carrier,
`packages/platform/sql/20260814010000_platform_control_plane.sql`, whole-file
SHA-256 `b0c8ef6424ebc6f1a84cb132c37908f4831fa40484a729c3713cfb35936559c9`,
with tuple `ui-12` 0 to 1, for a total of 14 paths and 16 tuples. Its one new
baseline key records that exact count; all earlier counts and scanner pins stay
unchanged. The asset preserves the canonical native forward's persisted channel
enum. Renaming that wire value breaks compatibility; omitting the asset breaks
the installed consumer. The existing exact pin is the smaller adequate route.
Each SQL entry pins the whole-file SHA-256 and exact category/before/after counts;
the registry entry pins its exact SQL COMMENT text, so unrelated registry edits
do not invalidate the pin. The filter applies on any base to measured-base
increases and parent-baseline raises, including `--write-baseline`. Candidate
counts must still fit the baseline. No wildcard, prefix or ceiling is admitted;
changed bytes, paths, categories or counts refuse, as do native, TypeScript,
docs and every other package SQL entry. An unrelated increase remains a failure in the same run.
Adding any further entry is a control change needing two independent fresh full reviews under the native review contract plus
the coordinator's control read. Neutral replacements reduce the debt; rail-path
entries can be retired after the F17 PR lands and the base carries their counts.
After all allowances are subtracted, a negative count fails the ratchet with
the category, quoted path and remainder; allowances never clamp counts to zero.

The opt-in fulfillment example lane subtracts only ui-15 at its exact source,
test, API-report and [A3 ledger](docs/platform/plans/oss-a3-fulfillment-adapter.md)
paths. Fixed registration carriers and platform change fragments admit only the
complete case-sensitive subpath token; the report filename is admitted only in
release gates and the publication catalogue. Outside paths, bare vendor prose,
lookalikes, casing changes and other categories still fail. The script's tests
exercise these plants and negative subtraction without changing the baseline.
Its installed-consumer proof imports the opt-in fulfillment entry
with optional peers and SDK absent, blocks ambient network I/O, checks the exact
runtime inventory and unselected/unready defaults, then exercises only injected
HTTP with explicit host readiness. Missing or malformed evidence refuses before credential
resolution; successful dispatch exposes closed evidence rather than command PII
or response bags. The focused glue tests do not replace the actual M08 conformance
runner or the supervisor's committed review and full gates.

The named first-party adoption example has a narrow prose allowance: only the
approved complete lines in the root README, the documentation owner's page and
the exact screenshot catalogue reference are counted once. It subtracts only
that adopter's name/domain categories. Changed or repeated lines, another path,
other brands and every other category still fail normally. Production code has
no exemption, and the baseline and pinned scanner chain remain unchanged.
The existing neutrality CLI tests cover both the admitted illustration and
refusals; changes to the approved wording need the same policy review.

Within one ratchet invocation, the pinned counts-mode scanners reuse the measured
base result only when the complete base and working inventories have identical
paths and bytes, including baseline, scanner and binary files. Both inventories
and pin checks still run; any difference executes both scanner chains. This
relies on the current deterministic counting interfaces, so scanner changes must
revisit that assumption. Separate CLI invocations never share scan results.

For pull requests and merge groups, the required `--policy` self-check also
compares the exact hosted event base with the checkout's Git objects. It refuses
edits, deletions and mode changes to existing managed or portable migrations,
backdated versions, unbound portable forwards and non-expand-only new SQL.
The portable manifest must preserve its prior baseline and forward prefix.
The CLI returns a failing exit when this comparison refuses a candidate.
Expand-only expression admission is covered by the predicate cases and the pinned
portable-chain admitted set in `scripts/source-preview-release.test.ts`;
`tests/postgres/expandOnlyExpressions.test.ts` separately executes refused forms
on disposable PostgreSQL 16 and observes their effects before rollback. The
classifier admits only listed expression calls and accounted structural
parentheses at verified object, column/type and constraint positions. Keyword-shaped
names do not skip expression checks. Seed INSERTs require VALUES immediately
after the target and optional plain column list; schemas take no schema elements,
and expand-only statements take no OWNED BY clause. These tests do not broaden
the separately reviewed creation class. Seed literal checks preserve identifier
quotes, and type-position parentheses require a listed built-in modifier type.
All base checks remain required after the additional refusal checks. Empty `[]`
suffixes are accepted only at verified type positions; array constructors and
subscripts refuse before element splitting. PG16 witnesses include a quoted
typed literal before a sequence call, an `if` column with a default call, and
a domain check inside an array default evaluated by a seed INSERT.
Expand-only token separators are ASCII space, tab and LF; non-ASCII outside
single-quoted literals and comments refuses, including in quoted identifiers.
The PG16 identifier-boundary witness observes a call after a name containing
non-ASCII bytes is truncated to PostgreSQL's 63-byte identifier limit.
This database-free comparison does not derive the live object inventory digest.
The source contract continues to bind the manifest bytes, and the portable
runner compares `objectInventorySha256` with the selected database catalogue
after applying migrations (falsified by
`server/adapters/postgres/migrationRunner.test.ts`).
Against the same base, `--policy` refuses a change that removes or changes a
line of a publishable package's API snapshot (`release-gates.json`
`packageSurface`) unless that package's single `## [Unreleased]` changelog
section or a validated package fragment in the exact head Git tree carries a
`Migration:` block, or a real coherent set bump above the base
has moved it into the unique candidate-version section while leaving a unique
empty Unreleased section. The candidate section must match the package manifest
and set; stale notes at an unchanged version, another version, duplicate
sections or a mixed set refuse. The base decides which packages and
snapshots are checked, and removing or renaming a subpath counts as a removal.
A pure addition, such as a name added to an export list, has no "before", so it
needs none; a comment that opens a line is ignored, the code on its lines is
not, and the head must keep each publishable package's gates file and snapshots
readable.

This is a textual, base-bound signal, not semantic migration certification. A
marker in a code fence or a reused block can satisfy it; declaration text that
reappears in order can look additive. Behaviour or schema changes and withdrawal
followed by re-admission of a package still need semantic review. Reviewers must
check the actual compatibility change and useful before/after migration steps;
the API snapshots, tests and release classification remain separate obligations.
Keep useful migration notes in a package fragment until release preparation;
legacy Unreleased notes remain valid and drain at the next set bump. A newly
approved bounded programme may combine the implementation and set bump in one
PR: the bump moves those notes into the candidate-version section and opens a
fresh empty Unreleased section. Do not duplicate notes into that empty section
to satisfy the gate. Separate implementation and release-preparation PRs remain
available within their actual authority.

The [diagnostic debt record](docs/platform/plans/public-ci-known-red.md#current-checkpoint) separates the last recorded checkpoint from earlier failures.
It records closure of the twelve SQL files and keeps earlier failures archived;
full-root and managed SQL diagnostics are expected green. Matching named debt is not
permission to ignore a red run. When triaging a change, compare fresh
Vitest failure identities and per-file assertion counts, and pgTAP file summaries,
with the exact PR base, normalizing log timestamps and ANSI formatting first.
The required `test` aggregate exposes root failures; `pgtap` remains a raw
diagnostic job. They do not suppress tests or normalize exits. Installation, database
start/replay/cleanup and unexplained new failures block delivery; naming those
failures does not waive broken CI. Use the hosted pull-request run's raw logs
for this comparison, or the corresponding local commands. The six existing required contexts retain
their coverage, with blocking lint and neutrality. Promoting diagnostic jobs to
required checks is the maintainer's ruleset decision; this contribution changes
no repository settings. Release workflows still check those six contexts, so a
red root suite now refuses release through `test`; raw pgTAP retains its diagnostic status.

For independently discovered documentation falsifiers and their proof limits,
follow [Test scope and diagnostics](#test-scope-and-diagnostics). Documentation
regeneration and export remain owned by [Documentation maintenance](docs/platform/DOCUMENTATION.md).

A change can be released as the next source preview when the required checks of
Published Tree CI pass and its tree describes itself: the publication catalogue
lists every tracked path, and `config/openlup-source-release-contract.json`
matches the tree's bytes. Adding, removing or renaming a file, or changing a mode
or a dependency, is releasable on those terms. Before it tags, the release
workflow checks the target against the previous preview with
`assertDescendantSourceRelease` (`scripts/oss-source-release-contract.ts`). That
check admits additive forwards and the separate exact reviewed function class under
[Data and migrations](docs/platform/DATA_AND_MIGRATIONS.md#additive-forward-release-path).
Reviewed function forwards use the same checker in required self-check and release
prepare. Their whole-file bytes, signatures, old/new definitions and runtime
privileges are pinned in `config/reviewed-platform-forwards.json`. The runtime
list admits the five-function capability forward and an optional service-only
identity capabilities forward. The optional portable replacement list binds
code-fixed functions for the dunning invariant repair, payment-terminal
decoupling and stock-evidence replay reopening. The stock control embeds the
candidate SQL in the existing synthetic gate tests without adding a migration.
The same focused test file covers exact bytes, portable-chain priors, registry
cardinality, header preservation, extra-statement
refusal and introduction-time binding in both gates; managed counts remain
unchanged. SQL and its pins may share a feature PR under the canonical
[co-located SQL/pin rule](docs/platform/DATA_AND_MIGRATIONS.md#co-located-sql-and-approval-pins).
Only bindings for that PR's new SQL may change; other entries and shared fields
stay fixed. Trusted-main native admission refuses co-changing the machinery.
Release preserves each binding from its actual mainline introduction; later
repins cannot authorize earlier SQL. New classes and control changes still need
prior separate approval. Batched pins land per rail as a prefix in version
order: all earlier same-rail pins must be present with their pinned whole-file
digests. The PG gate refuses landed holes and replays committed interleaved
files through the last pin along with the absent fixture suffix. These forwards
are not expand-only. See
[the exact class](docs/platform/DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards)
and its refusal tests in `scripts/source-preview-release.test.ts`.
It refuses edits or deletions of migration history, unapproved non-expand-only SQL, a
non-prefix portable manifest, bootstrap SQL changes, database schema types
(`src/integrations/supabase/types.ts`) and policy registry changes
(`config/openlup-policy-registry.json`). Nonmigration schema or policy changes
may still merge after their ordinary checks, but must be called out in the pull
request because the release-time check refuses them. [Versioning and EOL](.github/VERSIONING_AND_EOL.md#publish-refuse-and-recover)
states the complete rule. A preview carries no release asset; GitHub's release
attestation of the immutable release covers its annotated tag.
The protected release job creates the draft with the saved note bytes, checks
that same release ID and publishes by ID, changing only its draft flag. It never
discovers a draft through a paginated release list.

The workflow's prepare step also refuses, before it tags, a preview while a
tracked code file carries a removal marker
(`// openlup-remove-before: openlup-source-preview/<m>`) naming that preview or
an earlier one, or a comment line starting `// openlup-remove-before:` that does
not parse. Temporary compatibility files use such a marker so that a preview
cannot ship them past their announced removal.

Platform modules are contributed package-first: a reusable module becomes an
`@openlup/*` package with documented extension seams, and the reference
application consumes that package. Source-only changes are for the reference
application and documentation. While `@openlup/core` is below 1.0, the
packages are released as one set, independently of source previews: one set
version `0.N.P` from one commit, with each package tagged
`openlup-<package>-v<version>` at that commit and republished in every set. A
reviewed pull request, either release preparation alone or an explicitly approved
bounded implementation-and-set-bump contribution, runs
`npm run release:bump -- --set <version>`,
which updates every publishable package's version carriers and every exact
internal pin on one, and assembles each changelog's version section below a fresh
Unreleased heading: legacy Unreleased body first, then fragments in byte order
of path. All packages are validated and planned before writes, and only
consumed fragments are deleted after successful writes, then exactly those
deletions are staged so source preparation sees the updated Git inventory;
no other changes are staged. Historical sections
remain byte-identical. Merging it authorizes no release.
A release is then dispatched with `publish-package.yml` and package `all` for the
reviewed commit, and one maintainer approval of the protected `release`
environment authorizes every package of the set. Dispatching the set again
resumes one that stopped part way; preflight requires completed releases to keep
the exact reviewed release-note bytes in both skip and resume states. The package
workflow independently verifies the App-published immutable
release, tag and attestation, then publishes the checked tarball through npm
OIDC with `--tag latest`, without another approval.
[Package releases](.github/VERSIONING_AND_EOL.md#package-releases) lists every
check and the maintainer setup.

A new or renamed path needs its authored row in
`config/openlup-publication-catalog.json`, except the single fragment pattern
`packages/{core,outbox,platform}/changes/*.md`. These fragments are admitted as
`public-output` only after content and regular, non-executable mode validation;
nested directories and other extensions refuse. The catalogue remains an
explicit classification and execution inventory, not a generated list.

The bounded qualified-installation witness declares its exact future child path
in the [existing execution inventory](scripts/oss-publication-contract.ts).
The control-only registration precedes the E2 source: it permits no
other child path and changes neither entrypoint detection nor fixture rules.
The adjacent Vitest witness owns each disposable database and the child lifetime
used to close the production runner's internal pool. E2 supplies four fixed-pin
89-unit reference checks and four other-mode targets. F selects the two
restore-bound 90-unit shapes, with two production references and two renamed
other-mode targets, and exercises actual runtime/restore privileges and retained
data through that same child. These are prepared witnesses, not observed
qualification results; no child path or execution-inventory exception is added.

For a notable package change, add a uniquely named
`packages/<core|outbox|platform>/changes/<programme>-<slice>.md` fragment instead
of editing CHANGELOG. Use ordinary bullets, optional `###` subsections, useful
`Migration:` blocks and the existing size-growth bullet where needed. Empty
files, `#`/`##` headings and conflict markers refuse. No new universal fragment
gate is imposed; reviewers still check whether notes describe the change.
The existing Migration gate reads the exact head Git tree's fragments alongside
legacy Unreleased, validates fragments even for additive changes, and retains
the coherent prepared-version alternative. Source fragments never ship in npm.

Ordinary module and dependency PRs keep the committed source-release contract
snapshot unchanged. Both `--policy` and `--inventory` run its generator and
validate structure and authored identity, runtime, database seam and signed
compatibility. They report stale aggregate bindings without failing; missing
catalogue rows, broken derivation and other policy failures still refuse.

Refresh digests **at release preparation only**, after the set bump (when
applicable) and the authored catalogue updates, in the reviewed preparation PR:

```sh
node --experimental-strip-types scripts/source-release-preparation.ts --write
node --experimental-strip-types scripts/source-release-preparation.ts --check
```

The command validates live catalogue/inventory and migration inputs, plans the
snapshot before writing, then atomically replaces that file. It preserves
authored identity and compatibility, is byte-stable on repeat, and writes nothing
on validation failure. It never authors catalogue decisions. Commit the fresh
snapshot with the preparation change. Source-preview prepare, package/set
preflight, protected prepare/plan, and tag publication including resume require
canonical byte equality against the exact target Git objects. A later change to
a bound input requires another reviewed refresh. Remaining source bytes and
modes are bound by the target Git commit; the JSON is not a per-source content
hash list. Merging preparation still grants no release authority.

The [install support policy](.github/INSTALL_SUPPORT_POLICY.md) and
[publication completeness policy](.github/PUBLICATION_COMPLETENESS.md) describe
what the preview can and cannot demonstrate. They do not turn a preview checkout
into a stable or supported artifact.


The opt-in identity Auth/mail/database runner requires
`--phase email-trust|joint`; only the exported runner's optional `Setup.phase`
defaults to `email-trust`. Both phases replay the complete committed managed
chain, including the identity capabilities forward, and prove association under
the shipped grants. Every successful handler response is followed immediately by
a database read requiring its returned contact's normalized email and principal
link; confirmed and declared-provider scenarios also link a pre-existing unlinked
contact. The joint phase additionally checks unconfirmed soft provisioning and
first-login confirmation, refuses provisioning and existing-email linking under
automatic confirmation, preserves contact ownership after anonymous signup, and
requires no mail or account creation for unknown-address login. Refusal snapshots,
subscriber preservation and the public-catalogue fingerprint remain. The
[identity conformance guide](docs/platform/IDENTITY.md#conformance-and-outstanding-evidence)
describes prerequisites and proof limits. Default suites, required selectors,
CI activation and verification order remain unchanged.

<!-- openlup-doc-impact {"unit":"repository","digest":"sha256-3596f948904d4961b2dbc38a72006c3b2124a02cd29c604e736228e3d3787502","reason":"The compose container receives the optional invitation TTL. No service, route, contributor command or verification selector changes; the runtime and identity owners describe the setting and refusal behavior."} -->

<!-- openlup-doc-impact {"unit":"tests","digest":"sha256-9bc9d077d462c3b6b310bc4a61a79297acbcacc587ac490b1e067256431d8ed6","reason":"The component journey, optional captured-mail browser proof and direct disposable PostgreSQL proof reuse the existing runners. The PostgreSQL proof uses Node for server cryptography and explicitly binds the shared storage mocks and an empty URL query to window for the browser adapter; it needs no DOM. Test commands, execution ownership and full required verification duties remain unchanged; installation proofs continue to require their owned local services."} -->

For M12 self-service proof, discover the package composition tests, the default-off
reference binding test and the three PostgreSQL accountSupportSelfService cases
through the existing root Vitest projects after `npm run pretest`. Package owner-fit
checks import packaged subscriptions/payments types only and execute the TypeScript
checker. Reference-source action, preview, snapshot, explicit-pause and bundle-control
fit is compiled in m12SelfServiceBinding.test.ts, alongside its native routing
transcript. R1 portFit and m12AccountReadBinding proofs stay unchanged. The installed consumer
adds the facade result/refusal proof to its existing pack, while its root callable
removal falsifier does not repeat the positive installed operation. A missing
Docker daemon leaves real PostgreSQL proof outstanding; authored/typechecked cases
and synthetic owners do not establish database execution evidence.

## Pull requests

Dependency update bots remain signals for maintainer-owned signed contributions.
An ordinary lockfile update keeps the source-release digest snapshot unchanged;
PR checks derive live bindings. Only a reviewed release-preparation contribution
refreshes the committed snapshot before strict release admission.

For public questions and reports, follow the [support guidance](.github/SUPPORT.md)
and choose the matching form: [bug reports](.github/ISSUE_TEMPLATE/bug_report.yml)
ask for a version and reproduction, while [feature requests](.github/ISSUE_TEMPLATE/feature_request.yml)
ask for the problem, current workaround and why it belongs in Core. Send suspected
vulnerabilities through the private route in [SECURITY.md](SECURITY.md), never a
public issue.

### Local contribution handoff

If your agent lacks supported independent-review capability or you lack upstream write
authority, finish the authorized local change, signed commits and
[public required checks](#required-and-raw-checks), then hand off the existing
task record and commits to an authorized maintainer or supervisor. Include the
approved scope and delivery limits, full comparison base and head SHAs, changed
paths, check commands with exit codes, and unresolved or unavailable evidence.
For the fork setup above, obtain the committed head and validate DCO against the
recorded base:

```sh
git rev-parse HEAD
git diff --stat "$OPENLUP_BASE" HEAD
npm run check:dco-signoff -- "$OPENLUP_BASE" "$(git rev-parse HEAD)"
```

Stop there within local authority. Do not invent a review receipt or claim hosted
admission from local checks. The authorized supervisor takes ownership of native
review of the exact committed candidate, required verification, the PR head
source receipt comment, actual admission, and queue follow-through. Any
publication or merge also needs its applicable authority. The supervisor can be
the author only when that person has the required capabilities and rights.

### Deliver a change

This is the order for a task with an authorized submission supervisor, from
first edit to merge. An author preparing a local handoff follows the section
above; the supervisor owns the protected steps below. Each step points to its
detailed rule.

Record effective maintainer authority once in the existing finite task record:
actors, allowed coordination, local/DCO/submission/receipt/reply scope, actual
merge/release-dispatch grants and any authorized adopter continuation. Reconcile
later direct instructions. Do not ask again for an already granted routine
step, or treat another agent's request as a human grant. Required sensitive
reading, exact merge scope and protected release approval still apply.

1. **Worktree.** One task, one worktree and one branch, as in
   [AGENTS.md](AGENTS.md).
2. **Stabilize and commit.** Start with the useful vertical slice and a
   before/after witness that rejects the incompatible predecessor when preserving
   behavior. Run applicable existing policy, inventory and neutrality checks
   before broad tests, and use the [focused test examples](#test-scope-and-diagnostics)
   for the changed boundary to catch stale fixture inputs before counted review.
   Run focused contract/API/platform probes and existing native artifact
   checks before coverage or the broad root gate. For core, after its build,
   `npm --workspace @openlup/core run release:pack` checks native class/file and
   aggregate byte limits without substituting for final committed cold proof.
   Measure baseline headroom and generated-file amplification early; passing one
   class does not waive an aggregate cap. Diagnose contract, fixture, OS/permission,
   supervisor-input or hard-budget failures separately. Focused green never waives
   the complete required gate, and UNKNOWN is not a flake or retry permission.
   Run `npx --no -- ast-grep scan` after each change
   and `npm run lint` before committing, along with the applicable contract tests
   and working-tree package, API, neutrality and budget checks. If the task requires
   a maintainer read before sign-off, present one stabilized packet of API,
   npm-publishing, security-control and release-control changes and proposed gate
   budgets, and obtain that read before `git commit -s`. A working-tree pack
   preview is labelled as such; it does not replace the clean committed pack
   proof or final verification.
3. **Supervisor's native review** of the exact committed candidate, by the rules in
   [AGENTS.md](AGENTS.md) and in this section:
   - write `.context/scratch/agent-review/intent.json` in the shape the
     [native session interface](docs/platform/plans/autonomous-reviewed-delivery.md#native-session-interface)
     defines:

     ```json
     { "authorSessionId": "<your session id>",
       "intent": { "risk": "<prose|routine|behavior|unknown>", "scope": ["<changed paths>"], "criteria": "<approved criteria>" } }
     ```

     - read [Review lessons](#review-lessons) and put the simplicity pre-check,
       the smallest adequate alternative considered, in the first request as prose.

     - `risk` sets the reviewer floor: one reviewer for `prose` or `routine`,
       two for `behavior` or `unknown`.
     - Codex may omit `authorSessionId`, which is then taken from
       `CODEX_THREAD_ID`. Every other supervisor sets it to its own session ID.
   - refresh `origin/main` with `git fetch origin main`, then run
     `node scripts/agent-review-session.mjs prepare .context/scratch/agent-review/intent.json`.
     Its cheap merge preflight refuses a known conflict or failed carry-over before
     reviewers start. `verify-command` repeats it before expensive verification,
     and `receipt` before submission, against the locally fetched main. It does
     not fetch or promise that main will remain unchanged. An unlanded stack pin
     may still be reviewed locally; hosted admission waits for its prerequisite;
   - launch fresh reviewers and `record` each report;
   - repeat until `verify` reports `reviewed`. Three repair cycles are automatic;
     after `needs_owner`, only an owner decision recorded with
     `node scripts/agent-review-session.mjs continue "<note>"` adds three more.
     Follow [Regroup when work stops converging](#regroup-when-work-stops-converging)
     before further repairs when its condition is met.

   Preliminary local semantic snapshots help prepare the owner packet but are
   not this committed native admission. Preserve their findings and any real
   task-specific limit separately from the actual prepared session state; neither
   an informal round count nor an absent session resets or consumes native quota.
   This distinction never bypasses an actually applicable exhausted limit.

   The session state is `.context/scratch/agent-review/session.json`;
   `prepare --new <intent.json>` records a changed intent or a rebase in the same
   append-only session history; findings, reviewers and the repair count carry on.
   Only `continue` adds cycles.
4. **Local verification.** Finish source, generated inventories and tracked
   task/plan edits before the final proof interval. Build, pack, consumer and root
   commands sharing mutable dist/output run sequentially; parallelize only truly
   disjoint inputs. Put observations during the run in existing ignored evidence
   or PR records. A tracked delta invalidates the frozen final candidate: repeat
   affected cheap checks, then satisfy the native final gate on the actual new
   identity. Reuse only native-valid caches; no general result cache or skipped
   gate is introduced.
   - Where the maintainer-local layer is installed, run `openlup-dev verify` on
     the clean committed tree. It must report `REQUIRED PASS`, and it writes the
     stamp that the pre-push hook requires. An installation that does not support
     the mechanical integration alternative still requires its full run; never
     copy an older stamp or bypass its refusal.
   - Elsewhere, run the [required check commands](#required-and-raw-checks).
     Only the proved [mechanical integration alternative](#native-review-and-accountability)
     permits the bounded local selection described there. When native review
     evidence is available, the existing `verify-command` wrapper performs the
     merge preflight before the command. Refresh `origin/main` before the final run.
5. **Push** with `git push -u origin HEAD`. A push is publication, within your
   delivery authority. If `main` has moved since the review, push as is: verify
   and pre-push accept the review while its fork point is unchanged. Do not
   rebase or merge `main` to catch up (see [Merge queue](#merge-queue)).
6. **Open a ready pull request** within your delivery authority, using the
   template. End its description with your `Signed-off-by:` line: the merge
   commit takes its message from the description, and the DCO check certifies
   merge commits too.
7. **Post the source receipt** right away. `PR` is the pull request number;
   posting the comment is a GitHub write within your delivery authority:

   ```bash
   node scripts/agent-review-session.mjs receipt "$PR" | gh pr comment "$PR" --body-file -
   ```

   **Expiry.** Evidence expires 24 hours after the earliest counted PASS report
   for the current candidate. If expired, use `prepare --new <intent.json>`,
   obtain fresh reports, verify and post the refreshed receipt.
8. **Revalidate authority and evidence.** The pull request states its sign-off
   class and actual delivery grant. Recheck the live head, mergeability, check
   states and applicable review/receipt identity and expiry before each write.
   Any later material delta requiring a maintainer read returns to step 2 before
   sign-off. Required reads and closed material findings precede the request.
9. **Request auto-merge once** under actual merge authority, following
   [Merge queue](#merge-queue). With local proof, native review and the source
   receipt complete, pending hosted checks need not delay this request. Record
   whether it is waiting for checks or already queued; do not repeatedly arm it.
10. **Hosted checks.** The six required contexts and `native-review` must pass;
    GitHub then admits the requested PR to the queue automatically. Compare
    required root and raw `pgtap` failures with the exact base. A pending request
    is not successful admission or a completed merge.
11. **Merge group.** Read the group's `native-review` log (see
    [Required and raw checks](#required-and-raw-checks)). Carry-over needs no
    further receipt. If carry-over fails, merge `main` and re-review, then post
    the new source receipt. If the source evidence expired, refresh it and
    repost (step 7). If no usable receipt was found, submit it (step 7).
12. **Confirm the merge**: the merge commit on `main` and its push run.

A repair commit restarts from step 3 for the new candidate.

### Native review and accountability

The [autonomous delivery plan](docs/platform/plans/autonomous-reviewed-delivery.md)
uses one task supervisor to obtain independent fresh-context review through
native subagents or a supported local CLI under existing subscriptions. Follow
[provider-neutral execution](docs/platform/plans/autonomous-reviewed-delivery.md#provider-neutral-execution)
for context identity, observed completion, actor exclusions and task handoff.
Coordination, implementation and delivery may use different providers/models
within their actual grants. The maintainer need not move prompts or reports
between tools; no model API, backend, new host or authentication transfer is required.

Use one initial bounded review for ordinary prose or narrow routine code,
with two independent parallel reviews for sensitive or material behaviour,
executable instructions, contracts, controls and unknown risk. Review the exact
committed candidate without author history or another reviewer's verdict.
Record actual platform observations and complete findings;
blockers demonstrate an effect on correctness or acceptance, while optional
advice cannot block or require another edit after acceptance is satisfied.

Commit repairs before review. Give fresh reviewers the open finding cards and
obtain passing review of the new tree by the required reviewer count. Stable
finding IDs remain open until a report lists them in `closes`; every material
finding must be closed. Expiry is 24 hours from the earliest counted PASS report
for the current candidate. Reviewers must be cold, distinct from every author
recorded in the session history and each other, and not reused from earlier candidates.

Three repair cycles are automatic. `needs_owner` then requires the owner to
continue, narrow or stop; `continue "<note>"` records an authorized continuation
and adds three cycles. Follow the mandatory supervisor procedure in
[Regroup when work stops converging](#regroup-when-work-stops-converging);
it is not another native state gate. `prepare --new` records a changed intent or a rebase in the
same append-only session history; findings, reviewers and the repair count carry
on. Only `continue` adds cycles. A version-1 session file from before
2026-10-19 cannot be converted: delete `.context/scratch/agent-review/session.json`
and prepare again. A conflict or
failed queue carry-over is resolved by merging `main` and re-reviewing.

**Review after integrating main.** `prepare` can supply `candidate.integration`
with the preceding reviewed base/head/tree and its expiry. This requires a valid
PASS in the same append-only session, unchanged intent and author, and exactly
two merge parents: the prior head and the new review base on main. Two fresh
reviewers still approve the complete current tree against the approved criteria.
Their inspection may focus on the complete old-head-to-new-head delta, the
old-base-to-new-base delta, both versions of the task's own diff, conflict
resolution and interactions with the existing implementation. Read changed
admission, dependency, migration and other control machinery even when it is
outside the task's own paths. A merge commit can contain additional edits;
parent identity alone does not prove unchanged implementation. Supply these
pinned source identities, not old verdict text or author discussion. Uncertainty
requires full inspection within those reviews, not an automatic extra round.

`prepare` additionally marks `candidate.integration.mechanical` true only when
Git successfully computes the merge of the preceding reviewed head and new base
and its tree exactly equals the current candidate. This narrower case does not
consume a repair cycle. A conflicting merge, manual resolution or extra edits
use ordinary repair accounting, even when broader focused review is available.
Missing mechanical proof in an older session establishes no exemption; a new
prepare never retroactively refunds consumed cycles or an exhausted budget.

For this proved mechanical case, an authorized supervisor using the public
required-command route may avoid repeating the full local gate only when the
existing task record identifies the preceding full local PASS by exact head/tree,
commands and results, and complete green hosted evidence for the exact new main
base. The two fresh integration reviewers assess those inputs, changed contracts
and the affected local selection within their existing review. The prior full
proof must remain applicable to the current required commands and gate inputs.
A chain of mechanical integrations may retain that full anchor only with each
link's fresh review and successful local interaction checks recorded. A focused
PASS alone is never a full anchor.

Run the applicable existing cheap checks, including DCO, policy, inventory,
neutrality and whitespace, and the affected focused regression, type, build,
package or SQL probes on the actual current candidate. Record their commands,
results and exact identity in the same task record. Missing, failed, partial or
inapplicable prior evidence, uncertain interactions or changed required gate
obligations require the normal full local run. Installed verifiers retain their
actual stamp requirements unless their owning implementation supports this
alternative. No old stamp is copied, no full run is claimed for selected checks,
and `verify-command` still proves only its supplied command. Every required
source and merge-group CI command remains unchanged and must actually pass.

Focused integration review inherits the earliest source-coverage expiry; fresh
reports do not renew it. Reports are never copied to another tree. Findings,
reviewer uniqueness and repair accounting remain in the same history. Missing,
expired or unproven prior coverage, a rebase or `prepare --new` uses full review
under the normal reviewer floor. An unchanged prepare preserves existing evidence.
The receipt format and all mechanical checks are unchanged.

Handle `needs_agent_review` in the active task without asking the owner to repeat
approved behaviour. After criteria, review and checks pass, stop optional edits
and proceed only through authorized delivery steps.

`scripts/agent-review-session.mjs` binds process evidence to the candidate,
intent, scope and reviewer results. Installed verify and pre-push must refuse
missing, stale, partial or unresolved evidence; live enforcement is claimed only
after installed refusal tests pass. These receipts do not cryptographically
attest remote agent execution or establish hard author/signer OS separation.
Source objects are trusted through Git's own hashing, with
`transfer.fsckObjects=true` on hosted fetches. The earlier signed-receipt
controller and hosted observer are retired. No external model service is
required. Existing mechanical checks, DCO and applicable
publication/merge authority remain required.

Reuse the compact task record in the PR description instead of writing another
manual. Explain material deviations, evidence and remaining limitations. Review
must assess correctness, approved scope and whether unnecessary complexity adds
maintenance cost; findings need a concrete mechanism and effect, not a quota.

Each newly recorded native report must include a concise `documentation` string
(up to 4096 characters): identify the canonical sections checked, relevant
secondary instructions/examples and the assessment of no-impact reasoning.
For documentation-only edits, compare consequential claims with the selected
source/contracts rather than assuming no source delta means no risk. Search
related documentation for changed public exports, options and commands. Explain
why no related update is needed where that is the result; a bare “OK” does not
satisfy the review contract. The supervisor assesses substance, not just presence.
Existing recorded version-2 reports remain valid without rewriting history or
resetting cycles, findings or expiry; the requirement applies at new `record`
calls. Risk floors and the receipt format are unchanged.

Include the affected documentation owners and what changed in their explanations.
For a scoped no-impact record, challenge its reasoning as well as its fresh
fingerprint: a hash identifies the delta and its owner, not semantic correctness.
`--policy` prints every accepted reason.
Keep generic corrections upstream; separately owned applications document their
selected immutable release and own composition. Their private operations and
adoption state are not public platform documentation inputs.
Read the [AI contribution policy](.github/AI_CONTRIBUTION_POLICY.md) before
submitting material AI-assisted work. Human accountability and DCO, independent
native review, and actual task publication authority remain required.

#### Regroup when work stops converging

After two consecutive completed candidate evaluations that leave a material
obstacle to the same approved outcome, the supervisor must rethink the approach
before the next batch of repairs and proof. The initial candidate counts; the
required reviewers of one candidate constitute one evaluation, not two. Waiting
for another report, a test or infrastructure is not a completed failed attempt.
A PASS with an open material finding does not close the obstacle. Outside native
review, apply the same intervention after two executed attempts to resolve the
same acceptance gap without resolving it; repetition without new information can
trigger it earlier. Judge progress from existing results, without a second CI
counter. Stricter existing retry limits remain binding from the start.

In the existing task note, identify the two attempts and record briefly: the
remaining gap and its contract/owner; the cause and a simpler alternative; one
next discriminating step and its expected observable result. Question criteria,
test level and data, group findings by cause, and consider removing the cause
before adding cases or mechanisms. The same method may continue when new
information justifies it. End with the lesson `pattern → simpler path`.

Continue autonomously within approved scope, change technique, regroup within
that boundary or identify the actual missing owner decision. No extra reviewer,
challenge round or human read is required. A method, agent, context or PR change
does not erase the unresolved issue or its history. Do not repeat a rethink of
the same issue without decision-changing information. Existing `needs_owner`,
exhausted budgets and material contract changes keep their actual owner route.
Rethink grants no authority, cycles, finding closure, PASS renewal or extra expiry;
it does not run `continue`. The native `cycle` counts changed candidates except
proved mechanical integrations, not completed evaluations. No new CLI event,
receipt, job or counter is introduced.

### Review lessons

Each rethink ends with a one-line lesson. Before cycle 1 of a review, the author
reads this list and records a short simplicity pre-check in the first review
request as prose: the smallest adequate alternative considered. It is not a JSON
field or an encoded gate.

The supervisor appends each new lesson here, with its date and task, in the same
delivery when its approved scope includes this file; otherwise it adds them in
one bounded documentation change after delivery, which may collect several
lessons. When a lesson recurs, the supervisor promotes it into the guidance it
concerns in that same delivery and replaces the entry here with a pointer.
Promotion adds guidance only: it never relaxes a control, budget, review or
authority rule. This route grants no submission, merge or scope authority of its
own: a lessons change is an ordinary delivery under existing authority, and a
promotion stays within its approved scope. The rethink record and the task's
terminal self-retro carry the lesson until it lands. No other tracker is kept.

- 2026-10-29, M14 connected catch-up: fixture labels for observation authority
  or media visibility → use the existing bootstrap observer and exact domain
  SQL states before composing retirement and access expectations.

- 2026-10-29, documentation routing: duplicating a capability inventory in
  ownership selectors → route to its canonical section and specialize the
  neutral contracts, without introducing another registry or scanner exception.

- 2026-10-29, disposable Docker cleanup: same-module mocks hid per-project
  state and queued-signal failures → prove lifecycle invariants through actual
  Vitest project loaders and subprocess interruptions.

- 2026-10-29, M14 managed identity mapping: boundary edge gaps in a fixed
  mapper/control → validate existing input and command ordering at outer route
  entries directly before adding another mechanism.

- 2026-10-29, M14 schema-upgrade proof: diagnostic prose repeated a scanned
  token after the code fix → describe the mechanism without reproducing the
  scanner match, then check the committed tree.

- 2026-10-29, M14 ledger admission: successive special-case metadata checks
  left an untested catalog shape → use the canonical comparison and
  [single-deviation witness](#development-preview-checks) for this boundary.

- 2026-10-28, M14 handover cleanup proof: assumptions about failure metadata or
  network damage hid an actual created-container leak → test exact container
  disappearance and preservation of other owned resources directly.

- 2026-10-28, M14 installed application upgrade: a plain PostgreSQL driver
  decodes timestamps differently from the selected operations adapter → compose
  the existing gateway type overrides in the actual application connection.

- 2026-10-27, M14 qualified-runtime witness: generic lane escaped its reference
  binding → compose the existing named diagnostic lane and privacy unit of work,
  retaining the unchanged confinement test in focused feedback.

- 2026-10-27, M14 qualified-runtime proof: public contract type owner → use its
  correct existing entry, without adding an export or cast to fix a wrong import.

- 2026-10-27, M14 application lifecycle: lowercase-only identity missed the
  native `σ`/`ς` filename alias → extend the existing preflight equivalence
  while preserving prior refusals, and prove the observed collision before
  writes alongside exact-spelling replay.

- 2026-10-27, M14 A/C: ignored historical configs and source copies entered lint
  traversal → keep archival copies outside the checkout, following
  [commands and lint rules](#commands-and-lint-rules).

- 2026-10-27, M14 filesystem transfer: character counts and default UTF-8 key
  hashing lost admitted string identity → use explicit representation at byte
  and key boundaries, with the [transfer owner](docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery)
  and one real copy/resume witness covering both cases.

- 2026-10-28, M14 source-carrier neutrality: package/root green missed the cheap
  gate again → apply the existing working-tree neutrality order in
  [Deliver a change](#deliver-a-change) and its
  [required commands](#required-and-raw-checks) before review and broad proof;
  collect remaining cheap diagnostics before changing the candidate.

- 2026-10-26, M14 operations: package-local green missed existing closed size,
  nested-module and identity-profile inventories → trace exact consumer entries
  and run their focused selectors before the broad gate; preserve refusal checks.

- 2026-10-25, M11 stock reader: owner-only proofs hid caller and name-resolution
  failures → pin SECURITY DEFINER paths to `pg_catalog, pg_temp`, qualify
  application references, and prove behaviour as the granted role with hostile
  caller-session objects; reserve owner access for setup and state inspection.

- 2026-10-26, M12 inert composition: wrapping a generic keyed callable through
  `Parameters`/`ReturnType` erased the key/request/result relation → retain its
  type parameter at the entrance and execute a compiler witness with disjoint
  owner requests/results and an invalid request, alongside runtime delegation.
- 2026-10-25, M11 CTL notes: two review cycles in a row found stale statements in
  owner notes and pinned fixture comments (landed state, rail tails, admitted/draft
  wording) after each main landing → state only invariants in pinned or frozen
  text and point to the registry and real rails as the source of truth; verify
  with a volatile-pattern grep over everything the change owns.
- 2026-10-24, local verification rethink: replaying hosted shards and choosing
  resources from task names duplicated tests and silently selected one worker →
  use the [single local command set](#required-and-raw-checks), fixed phase
  profiles and the first root-worker observation; measure the next full run.
- 2026-10-24, queue integration rethink: mechanical base merges consumed repair
  cycles and repeated full local proof → use the proved mechanical case in
  [native review](#native-review-and-accountability), retaining fresh interaction
  review and full remote gates; [request auto-merge](#merge-queue) once after
  local prerequisites and the receipt, letting GitHub wait for pending CI.
- 2026-10-24, auto-merge handoff rethink: an enabled request remained outside
  the queue after all required checks passed → the [queue completion
  handoff](#merge-queue) rechecks existing authority and proof on the CI event,
  then inserts that exact head once; no watcher or new required check.
- 2026-10-23, execution-process rethink: repeated uninformative mutants and stale
  instruction copies → use [required behavior-class proof](#sufficient-evidence-and-material-test-gaps),
  [early regroup](#regroup-when-work-stops-converging) and
  [canonical instruction readback](#instruction-freshness-and-handoffs).
- 2026-10-23, co-located SQL/pins: a trusted script cannot enforce its own
  invocation → keep the documented workflow trust boundary explicit; reuse
  existing sensitive review rather than claiming status-name isolation.
- 2026-10-23, PostgreSQL teardown rethink: bounding only the fixture pool
  misses pools behind adapter/store `close()` → include every owned closer in
  the shared bounded close phase before attempting every container removal.
- 2026-10-19, native review simplification rethink: Resetting state and
  hand-copying fields across a session boundary drops whichever control was
  forgotten → never discard state: append a new intent and candidate to the
  same append-only history so every existing check still applies.
- 2026-10-15, module-boundary lint rule: cycles 0–2 each found another
  import-specifier escape → replace a growing denylist with an allowlist of the
  canonical forms, or reuse the resolver.
- 2026-10-15, the same rule and the owner's review of the rethink: hardening a
  checker cycle after cycle → question the criterion and the tool first.
- 2026-10-15, the review-cycle rule change itself: its compatibility proof
  checked an in-flight lineage at cycle 3, which then reached old-rule owner
  cycles 4 and 5 before the merge and was refused → a validator rule change
  must accept or explicitly migrate in-flight lineages; prove it against every
  live session's stored state just before merge, not only its current cycle.
- 2026-10-17, stacked-PR proof on module branches: squash landings defeat
  stacking, because any insertion into a shared list next to a predecessor's
  conflicts once it squash-lands → a merge-commit queue fixes it, because the
  merge base becomes the predecessor's head.
- 2026-10-17, module package pull requests: stacked pull requests that each
  regenerate one shared record (a doc-impact marker, a contract digest)
  conflict once the lower one squash-lands → the merge-commit and exact-predecessor
  guidance in [Merge queue](#merge-queue) supersedes that recovery. Follow its
  carry-over rule; integrate `main` for a conflict or refusal, not merely freshness.
- 2026-10-17, parallel module work: parallel heavy local test runs cause load
  timeouts → parallelize writing and serialize heavy test runs; after a load
  timeout the complete gate is rerun without the concurrent load, and the
  timeout never counts as a pass.
- 2026-10-18, M03 P-contracts lint boundary: each review cycle found another
  call shape that loads a module (wrapped `require`, `module.require`, process
  builtins) → refuse the ambient loader identifiers themselves, and
  `import.meta`, instead of chasing callee shapes.
- 2026-10-18, M03 P-contracts and B0: a renamed fixture or new path failed the
  neutrality ratchet only in the hosted self-check → run
  `node scripts/public-ci-neutrality.mjs` and
  `node --experimental-strip-types packages/ui/smoke/neutrality.ts` locally
  before every push.
- 2026-10-18, M02 C1, making `@openlup/platform` publishable: code, checks and
  fixtures that assumed the package was private or outside the release set had
  to change with the flag → grep every reader of the package's
  `publish`/`private` state (package inventory, package and release checks,
  consumer fixtures) before flipping it.
- 2026-10-18, OSS programme doc-impact records: one marker per unit, bound to
  the section prose, made every open pull request conflict on, or expire with,
  a hot section → bind the answer to the change and keep it in the change's own
  commits.

### Merge queue

**Workflow trust boundary.** Checking out `main` for the admission script does
not pin the `native-review` job definition: on PR and merge-group events,
`.github/workflows/published-tree-ci.yml` comes from the candidate tree. A PR
could replace admission with a successful no-op and self-admit under the same
required context. Native source review requires two independent reviewers for
`.github/` changes, and carry-over refuses a changed-tree group when the base
move touches `.github/`. These controls depend on review and on admission
actually running; they cannot enforce themselves against edited workflow YAML.
Another guard in that same YAML has the same limitation. The remaining in-repo
control is review of workflow edits. Closing the bypass requires a separately
authorized owner settings action: a ruleset-required workflow whose definition
is pinned to a trusted source outside the candidate's control, rather than only
requiring a same-name status. This hardening changes no ruleset or settings.

After a merge, the main-push jobs may reuse the successful merge-group run for
that exact commit. The probe validates the public repository, queue workflow,
latest run/attempt and seven successful checks: the six required contexts
and raw pgTAP. Missing, incomplete, contradictory or unavailable evidence runs
the normal commands. Pull requests and merge groups always run their commands;
DCO, policy/neutrality and secret checks also run for each main push. The six
main-push contexts still complete, so package release checks keep their existing
contract. This is commit equality, with no cross-commit cache or new retry.

`main` takes merge commits through GitHub's merge queue, which
builds and checks the fresh integration tree itself. A merge commit's message
is the pull request description, so the description ends with the author's
`Signed-off-by:` line; the DCO check certifies the merge commit and the merge
group's tip like any other commit. The
[base-move and receipt plan](docs/platform/plans/ci-base-move-and-receipts.md)
records why these rules exist.

- **No rebasing for freshness.** Do not rebase a pull request, or merge `main`
  into it, only because it is behind. A review is bound to the branch's fork
  point, so verify and pre-push keep accepting it while the branch is behind.
  Integrate `main` only for a textual conflict or failed carry-over/preflight,
  by merging it, and then obtain a fresh review, using the integration scope above when `prepare` proves coverage.
- **Arming.** Under actual merge authority, request auto-merge once after
  applicable local proof, native review, any required maintainer read and the
  source receipt are complete for the ready PR against `main`. Pending hosted
  checks may finish afterwards:
  `gh pr merge <PR> --auto --match-head-commit <reviewed-head> --author-email <address>`.
  The queue sets the merge method; use the maintainer's configured author address.
  Read back the live state: non-null GraphQL `autoMergeRequest` without a
  `mergeQueueEntry` means requested and waiting for checks; only a non-null
  `mergeQueueEntry` confirms actual queue entry. Neither is a completed merge.
  Observe an existing request instead of repeatedly arming it. If neither is
  present, confirmation is missing: read once again, then diagnose.
  Where activated, the trusted `Queue Handoff` completion workflow performs
  one `enqueuePullRequest` if GitHub has not queued the still-armed PR. It
  accepts only the latest completed source run and attempt, all seven actual
  required successes, current write-authorized intent and a valid native receipt.
  Each required job uses its latest result within that same run and head, including
  unchanged successes from an earlier partial attempt. A later failed, skipped or
  pending result cannot reuse an older success.
  It rechecks those identities before writing `expectedHeadOid`, with `jump:false`.
  It neither enables auto-merge nor authorizes an unarmed PR, retries a refusal,
  polls for checks or adds a required status. Group checks and admission still run.
  An aggregate failure from an optional diagnostic does not add another required
  check; each of the existing seven must itself have succeeded. A queue-entry
  event since the current arming request prevents automatic requeue, including
  after eviction or a repeated completion event; authorized recovery keeps its
  existing two-retry budget.
  Before requesting, revalidate the live head, mergeability, checks and applicable
  review/receipt identity and expiry. A known failed required check needs diagnosis;
  a pending check is left to GitHub. `--admin` is never this route.
  `DIRTY`/`CONFLICTING` stops enqueue attempts until the head or mergeability
  changes and the conflict is resolved; do not spend queue retries polling the
  same refusal.
  `UNKNOWN` permits one fresh read, then stops for diagnosis if still unknown.
  Leave `BEHIND` to the queue when carry-over remains valid.
- **Handoff identity.** Activation is a separate maintainer action. The dedicated
  App is installed only on this repository, with merge-queue write, contents write
  and pull-request read permissions, and no bypass. Its private key is the
  `OPENLUP_QUEUE_APP_PRIVATE_KEY` secret in `openlup-merge-queue`, an environment
  restricted to the `main` branch with no per-run reviewer. It is never a
  repository secret or a reused release credential. The public
  `OPENLUP_QUEUE_APP_CLIENT_ID` variable enables the workflow only after that
  restriction and the App's actual permissions are verified. The built-in
  workflow token stays read-only; the short-lived App token is used only for the
  single queue mutation. The workflow runs default-branch code, without checking
  out PR code or downloading its artifacts. Missing activation is not an
  autonomous-handoff claim.
- **Receipts.** While native admission is active, a supervisor with delivery
  authority posts one source receipt per reviewed PR head as soon as the pull
  request is open and ready, using step 7. A group that cannot carry over is
  rejected: merge `main` and re-review, then post the new source receipt.
  Posting a receipt comment does not retrigger CI: after the 20-minute wait expires, rerun the `native-review` job.
- **Flakes.** A removal counts as a flake only when the same job passed on the
  same tree, or a `gh run rerun` passed without a code change. One requeue for a
  flake uses the existing two-retry budget. A second removal of the same head
  stops for diagnosis. A `native-review` red caused by a missing or late receipt
  is not a flake.
- **Receipt timeout.**
  - On a pull-request run, submit or check the source receipt, then rerun the
    failed `native-review` job. The rerun is a GitHub write; it requires
    authority that covers reruns.
  - In a merge group, requeue under merge authority. The new group is admitted
    by the source receipt again when the review carries over. A carry-over
    refusal requires merging `main` and re-reviewing. The requeue uses the same
    two-retry budget, and a second timeout on the same head stops for diagnosis.
  - A timeout although a current source receipt was submitted in time is a
    defect on a pull-request run, or on a merge group whose log names no
    carry-over refusal: stop and report it. An expired receipt or review needs the
    re-review and resubmission described in step 7.

**Stacked pull requests.** Once a predecessor merges, the merge base of a pull
request stacked on it is the predecessor's head, so the stacked change merges
onto `main` without conflict, even where it regenerates the same records or
inserts lines next to the predecessor's. Stack pull requests that build on each
other or touch the same shared files:
- A stacked branch contains its predecessors, and its generated files are
  computed on that cumulative tree. Export `OPENLUP_STACK_BASE` with the exact
  predecessor head for documentation, native review and final local checks.
  Its doc-impact answers and reviewed diff then cover its own change.
- Open it as a draft with its predecessor's branch as the base, after
  `npm run oss:published-tree -- --policy --docs-base <predecessor-head>` with
  the pinned SHA. Review its own diff with predecessor context; readiness and
  source receipts wait for the prerequisite.
- When the predecessor merges, GitHub retargets the pull request to `main`,
  because head branches are deleted on merge. Continue only once the first
  parent of `refs/pull/<PR>/merge` is `main`'s head; if that ref is stale,
  close and reopen the pull request and check again. Then rerun its checks
  against `main` by marking it ready; if it is already ready, convert it to
  draft first, which clears auto-merge. Then submit its source receipt and arm
  it: the receipt and queue admission require a pull request against `main`,
  and admission takes only the first queue entry. Keep the original pin: the same
  unchanged candidate remains locally reviewed after its predecessor lands.
  Admission verifies the pinned base is on actual main, not merely present on
  the source branch. Each upper PR still needs its own source receipt.
- Before relying on carry-over, check `git merge-tree --write-tree` of the queue
  base and the head. The canonical carry-over rule applies: unchanged tree or
  exact disjoint application relative to the reviewed predecessor.
  A moved `packages/<name>/package.json` does not block carry-over when main's
  and the change's edits to it only add new, disjoint subpath `exports` keys,
  preserve existing values with order-sensitive comparison, and leave every
  other key unchanged. The merged manifest must preserve those values and contain
  exactly both additions; root manifests and lockfiles still block.
  Other base changes are rejected: merge `main` and re-review.
- If another change on `main` conflicts with it, merge `main` into it once (do
  not rebase), regenerate its shared records and get fresh review, using the
  integration scope above when `prepare` proves coverage.
- If a predecessor changes, merge its new head into each stacked pull request
  above it (do not rebase); each result is reviewed again under the usual repair
  rules and budget.
- A second ejection of the same head stops the stack for diagnosis.

Each stacked pull request is still one concern. Stacking changes no review,
receipt or merge rule.

Use one concern per pull request. Describe the problem, the public contract that
changes, compatibility implications, and the checks you ran. Keep adopter-owned
brand, content, catalogue, local policy, and business-specific integrations out
of generic platform changes unless the proposal explicitly establishes a public
extension seam and a compatibility owner.

<!-- openlup-doc-impact {"unit":"public-policy","digest":"sha256-5bb2e80c19164bd0c6a922777d341fa2f84f2dcb09393efdc5124f5530f02c7c","reason":"Deletion delta. The actionlint configuration is deleted; its only entry suppressed an input warning for a workflow this tree does not have. The pull-request policy and checks described here are unchanged."} -->

## Developer Certificate of Origin

Every commit in a contribution must carry a sign-off:

```text
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds the line. It certifies that you wrote the contribution, or
have the right to submit it under the project licence, and understand that the
contribution and its sign-off are public and permanent. There is no CLA.

Before opening a pull request, verify the range with:

```bash
npm run check:dco-signoff -- "$(git rev-parse <base-commit>)" "$(git rev-parse <head-commit>)"
```

Published Tree CI validates the same sign-off requirement for each pull-request
commit.

## License

By contributing, you license your contribution under the Apache License 2.0 in
[LICENSE](LICENSE).
