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

Obtain the accountable human's scope and delivery authority under the
[AI contribution policy](.github/AI_CONTRIBUTION_POLICY.md). Use
[Deliver a change](#deliver-a-change) for worktree setup, the PR task record,
review and delivery. A generated plan or review receipt cannot extend authority.
Consider removing the cause or using an existing seam before adding an abstraction.

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
open findings and failed attempts from the existing task record.
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
   the six hosted shards feed the required `test` aggregate.
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

[Development, diagnostics and preview releases](docs/platform/DEVELOPMENT_AND_RELEASE.md)
explains CI triggers, diagnostics and release mechanics. The commands below
describe CI and optional full local feedback; required verification runs in hosted CI under
[Deliver a change](#deliver-a-change).

Use the [source map](docs/platform/SOURCE_MAP.md) to find each changed contract's
owner and nearest tests. Package and installed-consumer checks establish artifact
boundaries; a fixture does not establish hosted qualification or provider access.
For SQL mechanics and migration witnesses, follow
[Data and migrations](docs/platform/DATA_AND_MIGRATIONS.md).

The policy self-check validates local Markdown links and fragments, generated
navigation and agent-context freshness. See
[Documentation maintenance](docs/platform/DOCUMENTATION.md) for ownership and generation.

### Local stack bases and heavy verification

Stack setup and `OPENLUP_STACK_BASE` are defined in
[Deliver a change](#deliver-a-change).

Heavy local commands are optional feedback for the code being written; the
required verification is hosted CI. To run one against the reviewed candidate, use
`node scripts/agent-review-session.mjs verify-command --resource openlup:coverage -- npm run test:scoped`.
It checks the clean committed candidate and its review before and after the
command and preserves the command's exit code. With `--resource` it runs through
`ai-resource-gate`, whose policies stay binding; it refuses nesting inside another
broker or wrapper.

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
[image inventory](config/ci-images.json): four PostgreSQL images (the install-proof
database, also used by pgTAP and managed-rail tests, the test harness default, and
two attribute-version witness pins) plus the starter browser image.
Every pin is validated before the first registry request. No Supabase CLI or
derived image set takes part.
The reviewed-batch gate and shared PostgreSQL test helper read these JSON pins
through [the shared reader and pull loop](scripts/ci-image-pull.mjs). The reader
imports the JSON module directly so the same pins load in plain Node and both
Vitest projects, including jsdom. In CI and locally they try the organization
mirror first, then the upstream order with the same digest: Docker Hub, then
ECR, for all four library PostgreSQL pins. Private or absent organization
packages do not remove these public upstream fallbacks. The required
`install-packages` PostgreSQL startup step is an exception: it selects only the
GHCR mirror and requires access to that organization package. Microsoft registry
sources, such as the starter browser image's, are mirror inputs only: that image
is pulled from the organization mirror alone, with no upstream fallback.
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
(30s per image), all inside the pull budget. There are at most nine pulls per
image.
The shared loop retries transport, context-deadline, killed process timeout,
registry 5xx and 429 failures. Mirror not-found,
denied or unauthorized errors immediately fall through without retry when an
upstream source is selected. Library PostgreSQL consumers retain Docker Hub/ECR
fallback in CI and locally, except the required `install-packages` PostgreSQL
startup step, which selects only the GHCR mirror. An empty or inaccessible private
organization mirror does not by itself fail the other PostgreSQL consumers;
that required startup step has no upstream fallback and requires organization
package access.
Local daemon/disk/malformed failures, upstream non-transient errors and pinned
RepoDigest mismatches refuse rather than silently selecting another image.
The gate's offline guard rejects literal digest pins or registry source lists.

The pgTAP runner pulls its single image, the install-proof `postgres:17` pin,
through the same loop and starts it with `--pull=never`. Every pull and local
reuse requires the exact pinned index digest; the loop refuses a tag-only input.
No upstream push or registry
write occurs. Other launchers retain their existing acquisition behavior. The
package-proof PostgreSQL 17 service is started explicitly after GHCR login,
using the exact inventory digest from the organization mirror with `--pull=never`.
It is removed even when package proof fails.
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
visibility**, select **Public** and confirm. Check anonymous mirror pulls after
making packages public. PostgreSQL consumers with upstream sources fall back
while packages are absent or private. The required `install-packages` PostgreSQL
startup step and the starter browser image are mirror-only exceptions: an absent
or inaccessible organization package fails `install-proof`. `GITHUB_TOKEN` cannot
make a package public; linking a public repository does not change package visibility. See GitHub's
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

Required root `test` accepts only success from all six `test-full-shard` jobs;
failed, cancelled or skipped shard jobs refuse it. Main-push reuse requires a
complete successful exact-commit merge-group run, including raw pgTAP.
The `test-full-shard` and `pgtap` jobs authenticate ghcr.io pulls with the
job's `GITHUB_TOKEN` and `packages: read` before non-reused tests; login failure
fails the job.
`install-packages` and every `install-browser` shard also authenticate before
their first image pull. The package job starts its PostgreSQL service in a step
after login, using the organization mirror only.

The raw `pgtap` job, which the required `test` aggregate also requires, follows the
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
each of which must fail. It is not a required context of its own; the required
`test` aggregate, which native review waits for, requires it.

See [Test scope and diagnostics](#test-scope-and-diagnostics) for selection,
sharding, discovery and test-author guidance.

The required `install-proof` context aggregates `install-packages` and all four
`install-browser` shards. It requires actual success from both dependencies; failed,
cancelled or skipped jobs refuse admission. On main pushes, `install-packages`
checks `scripts/public-ci-reuse.mjs`; browser shards share its decision so a
reused producer never leaves a consumer without artifacts. Expensive steps skip
only with successful exact-commit merge-group evidence, leaving successful
dependency jobs for the aggregate. The six required context names and native-review dependencies stay fixed.

`install-packages` runs the shared package gate after both reference-profile builds,
independently of the required `test` job in a separate checkout and installation. It discovers every publishable package from `config/openlup-packages.json` and its actual npm workspace, and refuses missing `api:check`, `ci:required` or `test:consumer` scripts before packing. The existing cold producer emits one current-set manifest. All API checks run before any package's `ci:required`, which receives the same verified manifest and exact checkout commit through `OPENLUP_PACK_MANIFEST` and `OPENLUP_PACK_COMMIT`. Cold preparation clears each workspace per target, so the API phase restores each package's built declarations and prerequisites through the existing build helper; it leaves the retained tarballs untouched and includes that cost in its timing. There is no missing-script skip or package-name routing table. A new module must supply installed-artifact consumer coverage, meaningful failure cases and its owning required batch; script declarations alone do not prove that those assertions are sound. Review checks that the batch actually invokes its consumer and preserves its required tests. Keep API checks out of that batch because the shared phase already runs them.

After package proof succeeds, `install-browser` runs the starter's installed
PostgreSQL browser journeys in four parallel shards through
[`starter-browser-ci.mjs`](scripts/starter-browser-ci.mjs). Pinned official artifact
actions transfer only the verified manifest and public tarballs from the package
job, retained for one day; private browser output is never uploaded. Each shard
verifies all manifest hashes, the package inventory and the exact checkout commit
before installing, then checks installed-package confinement. The zero-based
`--groups` selections are `0`, `1,6`, `2,4` and `3,5`, covering every group once.
Each shard acquires an isolated disposable
PostgreSQL 16 per configuration through the shared test helper and `test-postgres`
inventory pin. The package job's PostgreSQL 17 service retains its package proofs. The runner
installs and seeds both demonstration configurations, verifies migration replay
and the restricted runtime identity, and starts two loopback hosts per group.
The seven shared selections are subscription care; portal; recovery extension;
combined operator operations, returns portal and shipment operations; combined
payment guidance, account preferences, embedded browser and billing profiles;
payment retry; and the remainder. Setup failures stop before another group is
acquired and report the group and phase; Playwright failures allow later groups
in that shard to retain their diagnostics. An authenticated
GHCR pull selects the pinned `starter-browser` image through the shared reader
and pull loop; mirror failure refuses without a vendor fallback or browser
download. Playwright runs the database config with one worker, traces, video and
screenshots off, read-only application inputs and temporary container results.
The private care fixture matches each host to its runtime/owner connections and
mailbox directory. Only that care directory is writable in the browser, which
runs with the host user identity to preserve private capture permissions.
The script captures output privately, scans it for credentials, removes its
hosts, containers, databases, roles and scratch files on success or failure, and
prints the public image identity, counts, timings and bounded failure diagnostics. It uploads no artifacts.
Current deadlines are 12 minutes for packages, 8 per browser shard and 2 for
the aggregate. Set each job deadline to at least 1.3 times its slowest observed
hosted run.
Browser journeys retain zero retries. See the
[starter proof recipe](examples/neutral-store/docs/proof.md#database-backed-purchase-acceptance-recipe)
for the selected journeys and the separate local proofs.

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

To inspect the same local obligation plan the runner executes, before committing
or requesting review:

```sh
node scripts/verify-local.mjs --plan
node scripts/verify-local.mjs --plan --json
# Include the raw DB diagnostic when its inputs are in scope:
node scripts/verify-local.mjs --plan --pgtap
```

Planning is read-only and works on an unreviewed, dirty task worktree without
dependencies, a broker or scanner. It lists each phase's command, environment,
owner, reason, prerequisites, resource profile and corresponding CI context.
It does not select fewer mandatory phases, run checks, establish native review
or create verification evidence. Output paths are placeholders until execution.
An unreadable Git comparison reports unknown scope, retains all obligations and
exits 2; recover the missing history or valid stack pin before execution.
The candidate's changed paths describe committed changes only; `clean: false`
also warns of pending working-tree changes. Package discovery and bounded root
tooling selection remain with their existing owners, not a second selector.

For optional local feedback after committing and recording the required native
reviews, run the full local command set with `node scripts/verify-local.mjs` from
the task worktree root.
Add `--pgtap` when the change reaches database inputs (including runtime, fixture,
configuration or harness changes), or when requesting that raw diagnostic.
The runner uses the commands below once: a single locked install, lint's package
prerequisites, both reference builds, shared package/API/coverage gates and one
`test:scoped`. Hosted shards, event-bound dependency comparison and receipt
admission remain hosted checks; this optional command is local feedback.

Each phase uses the existing native before/after review and candidate checks.
Where the optional resource broker is installed, a closed phase map selects its
existing coverage, build, typecheck and pgTAP profiles; task names never select
resources, and an unknown phase refuses before execution. Otherwise the native
wrapper runs directly. Logs retain exact commands, profiles, exits, timings and
the first root-worker observation; later synthetic fixture output cannot stand
in for it. Machine resource policy and explicit worker settings remain effective.
Tree-wide and UI neutrality run before installation and heavy phases: their
Node/Git checks need no dependencies. All thirteen mandatory phases remain;
pgTAP is still explicitly selected. The runner consumes the explained plan;
execution still checks the current candidate and review before/after commands.
Build/package/root phases stay serial because they share generated outputs.
SSR output stays in a unique ignored worktree scratch directory so external npm
imports still resolve; cold package artifacts stay outside the checkout.
The first failure stops the run without an automatic retry or reuse of earlier
passes. The manual equivalents remain available:

```bash
# Cheap checks need no dependency install.
npm run oss:published-tree -- --policy
npm run oss:published-tree -- --inventory
# dco (needs no install): the commits your branch adds to origin/main
npm run check:dco-signoff -- "$(git rev-parse origin/main)" "$(git rev-parse HEAD)"
# gitleaks: complete history, as on main pushes; CI scans only a PR or merge-group range
gitleaks git . --config config/gitleaks.toml --redact --no-banner
node scripts/public-ci-neutrality.mjs --base-commit "$(git merge-base HEAD origin/main)"
node --experimental-strip-types packages/ui/smoke/neutrality.ts
# The runner uses the validated OPENLUP_STACK_BASE instead of the fork point
# for a stacked task. Keep that exact same comparison base in manual commands.

npm ci
# npm run lint and npm test build Core, Outbox and Platform through pre-scripts.
# typecheck
npm run lint
npm run oss:published-tree -- --typecheck
# install-packages, under install-proof (CI installs with: npm ci --prefer-offline --no-audit --fund=false)
npm run build
OPENLUP_REFERENCE_PROFILE=subscription OPENLUP_BUILD_OUT_DIR=dist-subscription \
  OPENLUP_SSR_OUT_DIR=dist-subscription-ssr npm run build:public-reference
# install-packages: package gates after both builds on a clean signed candidate
# Keep package gates before root tests locally: one checkout shares build outputs.
GATE_PACKS="$(mktemp -d)"
# Local SQL proof owns one ephemeral PostgreSQL container; CI passes the explicitly started container identity/port.
node --experimental-strip-types scripts/packages/required-package-gates.ts \
  --out "$GATE_PACKS" --expected-commit "$(git rev-parse HEAD)"
# test: omit bounded tooling fixtures whose inputs are untouched, including dirty files.
npm run test:scoped
# Hosted test-full-shard runs six parallel independent installations, each with:
# node scripts/ci-test-scope.mjs (OPENLUP_VITEST_EXCLUDE_FILE points to runner temp)
# npm test -- --shard=N/6 (N = 1, 2, 3, 4, 5, 6)
# pgtap (Docker required; no Supabase CLI or npm install)
node scripts/public-ci-pgtap.mjs
```

The `prelint` and `pretest` scripts build Core, Outbox and Platform in dependency
order. Before direct typecheck or Vitest commands after install or package-source
edits, run `npm run pretest`; otherwise consumers may read stale `dist/` exports.

The [reviewed-forward PostgreSQL proof](tests/postgres/reviewedPortableCreation.test.ts) rejects landed pin drift before replay and tests byte selection for full and partial landings; [data and migrations](docs/platform/DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards) describes its catalog boundary.
See the [invoicing forward owner](docs/platform/DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval) for managed correction finalization and parking. The fixture and registry do not install SQL.

For the managed pgTAP runner, prerequisites and proof limits, follow
[Test scope and diagnostics](#separate-db-package-and-coverage-proof).

The three `oss:published-tree` modes are distinct checks. `--policy` verifies
the public policy, catalogue, documentation ownership, generated navigation and
source-map freshness; `--inventory` verifies the selected
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

Published Tree CI runs the mechanical checks against the actual queue group.
DCO includes the synthetic tip. Pull-request attribution uses `GITHUB_SHA` and
the exact event-base and head parents; `merge_commit_sha` in a synchronize payload
may lag. The optional local mirror runs raw diagnostics only on request or when
database inputs select pgTAP. Review and receipt mechanics are defined in
[Deliver a change](#deliver-a-change).

For package contract tests and installed-consumer witnesses, follow the
[platform package reference](docs/platform/PLATFORM_PACKAGE_REFERENCE.md) and
[package guide](packages/platform/README.md).

### Commands and lint rules

The complete projected root command inventory is `build`,
`build:public-reference`, `build:public-reference:client`,
`build:public-reference:prerender`, `build:public-reference:ssr`,
`check:dco-signoff`, `guard:client-secret-boundary`,
`guard:public-reference-site-routes`, `inventory:refresh`, `landing:merge`, `lint`, `preflight`, `prelint`,
`oss:published-tree`, `packages:check`, `release:bump`, `sql:admit`, `pretest`, `test`, `test:hosted`, and `test:scoped`.
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

Use the pinned Node version in [.nvmrc](.nvmrc), npm 11.19.0 and the committed lockfile in your task worktree. Run the tests being written locally, in hosted parity with `npm run test:hosted -- <files>`; [required and raw checks](#required-and-raw-checks) describe hosted CI and optional full local verification.

#### Run and inspect

After `npm ci`, use:

```sh
# Builds Core, Outbox and Platform, then runs the affected root tests.
npm test -- server/domains/subscription

# The same, the way a hosted test shard runs them; at least one file is required.
npm run test:hosted -- scripts/ci-test-scope.test.ts

# Advisory self-checks over the change since the fork point, before prepare.
npm run preflight

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

`test:hosted` runs the named root test files through `npm test` with the
settings of a hosted `test-full-shard` job: `CI=true`; no coverage (a
`--coverage` flag or coverage environment is dropped); no external duration
pins, so the flat test timeout applies; no exclusion file, so every named file
runs; three workers, the Vitest default on the 4-vCPU hosted runner; and the
runner's `TZ=UTC` and `LANG=C.UTF-8`. Git sees `GIT_CONFIG_GLOBAL=/dev/null`, no
`GIT_AUTHOR_*` or `GIT_COMMITTER_*` variables and `user.useConfigOnly`, so a
fixture commit without explicit identity fails locally as it does on a runner,
instead of using an identity guessed from the host name. It does not reproduce
the hosted runner's CPU speed; size bounds for hosted runners as described below.
Locale overrides (`LC_*`), a system gitconfig and `OPENLUP_STACK_BASE` are also
removed; other local environment variables pass through unchanged.

`preflight` is advisory: no CI job or review step runs it, and it exits non-zero
only when a check reports `FAIL`. It reads the change since
`git merge-base HEAD origin/main`, plus uncommitted and untracked files, and prints
one `PASS`, `WARN`, `SKIP` or `FAIL` line per check:

- the published-tree typecheck of the required `typecheck` job, after the package build;
- the ast-grep scan from [lint rules](#commands-and-lint-rules);
- `npm run inventory:refresh` when SQL under `db/` or `packages/*/sql/` changed;
  it has no check mode, so a rewritten inventory stays in the working tree and
  is reported for commit. It needs Docker and reports `WARN` without it; because
  it refreshes five disposable installations, a preflight on an SQL change may
  take longer than three minutes;
- a `changes/*.md` fragment for each released package whose `src/` changed;
- on added lines of test files, literal ISO dates within 400 days of now and
  expiries or TTLs under ten minutes; these simple patterns can misfire, so
  explain a false positive instead of contorting the test;
- `gitleaks` with the repository configuration, when it is on `PATH`;
- `test:hosted` for the changed root test files;
- the tree-wide neutrality ratchet of the required `self-check` job,
  `node scripts/public-ci-neutrality.mjs`, against the fork point.

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

Hosted `test-full-shard` jobs run `npm test -- --shard=N/6` in six independent installations. They apply the same event-based selection before sharding. Required `test` accepts only success from the whole matrix and from the `pgtap` job; failure, cancellation or a skipped dependency job refuses. There is no `test:required` script or separate `test-full` job. A successful shard can still report individually skipped cases; record missing proof.

Channel preservation tests live in `packages/platform/test/channels` and are
discovered by the existing root Node project. The reference's adjacent guard
tests cover off/portable selection; `tests/postgres/m17ChannelReference.test.ts`
uses actual imported locked rows in local managed compatibility PostgreSQL,
with adapter defaults revoked before installation, to prove page/capture/CAS
order, original money groups, current-run recovery and
ACK debt. This local witness does not qualify hosted managed or provider access. The paired PostgreSQL boundary
fixture and selected-native inventory proofs live under `tests/postgres`;
managed pgTAP retains 48 source-boundary assertions and the existing dispatch
owner witness. Installed artifact proof belongs in `tests/platform/channels`;
the canonical cold runner requires all three channel entries and checks their
imports and both declaration modes. Registration alone does not establish
passing final canonical verification.
These local witnesses do not establish real-provider or hosted qualification.

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

[Required checks](#required-and-raw-checks) owns the full command sequence. `install-packages`, under the required `install-proof` aggregate, builds both profiles and runs [shared package gates](scripts/packages/required-package-gates.ts): cold-pack the publishable inventory once, all API checks first, then each `ci:required` with verified manifest/commit. Keep local package preparation before root tests because generated outputs are shared. New modules extend the owning package's consumer and required batch; do not add a workspace or job without a separate need.

Core required coverage is V8: statements/lines 80%, branches 65%, functions 75%, plus no nonempty production file with zero covered lines. Root config has percentage thresholds when explicitly running coverage; public CI does not run root coverage or its separate no-zero helper. Outbox/Platform have no separate percentage gate. Keep installed-artifact and meaningful failure assertions; percentages do not replace them.

Root tests include required disposable Docker/PostgreSQL proofs. Some older tests explicitly skip when Docker is absent; a skip does not prove that boundary. Installed Outbox/Platform consumers require their owned database and refuse missing infrastructure. For managed SQL use `node scripts/public-ci-pgtap.mjs` with Docker; it needs neither the Supabase CLI nor npm dependencies. It validates committed migration bytes, starts one disposable stock PostgreSQL 17 container with the checksum-pinned pgTAP, `pg_cron` and `pg_prove` packages and the managed-compatibility adapter, replays baseline/forwards with public prerequisites, runs all supplied SQL tests and removes only its own container. Commit migration candidates before this runner; it refuses dirty migration bytes. It never links a hosted database or installs application seed data; it copies the shipped SQL tests unchanged. Replay uses a disposable diagnostic owner with closed default grants, so this profile is not production installer authority or a managed-host certification.

In CI, pgTAP is required through the root `test` aggregate, as is package `install-proof`; locally it remains a raw diagnostic. Triage actual exits, failed/aborted files, skipped prerequisites and new failures against the exact base; [historical diagnostic evidence](docs/platform/plans/public-ci-known-red.md) grants no waiver. Neither mocks, static SQL assertions, listing, a build nor a green aggregate proves an unexecuted DB/browser/provider obligation.

Local root coverage (`npm test -- --coverage <path>`) runs Vitest directly when
the host-local broker helper is absent, with the same arguments, environment
and coverage-summary handling as an already admitted run. A focused subset still
uses root percentage thresholds; it does not establish full-suite coverage.

Keep documentation falsifiers independently discoverable for routing, navigation, bare-runtime CLI and bundle corruption; never import one test file from another. Disposable fixtures prove those refusals, not arbitrary prose meaning. Follow [lint rules](#commands-and-lint-rules), including valid/invalid cases for new ast-grep rules, and [documentation navigation](docs/platform/DOCUMENTATION.md#navigation-and-source-map). Fixtures still obey neutrality and secret-handling policy.

### Package, policy and release checks

`npm run packages:check -- --manifest-only` checks every `packages/*/package.json` against
[`config/openlup-packages.json`](config/openlup-packages.json), which lists each
package as released or as unreleased. A released package `packages/<name>` is
named `@openlup/<name>` and has its own `MAJOR.MINOR.PATCH` version, exact pins
to the current versions of other released `@openlup/*` packages, registry semver
ranges for every other dependency, and curated `exports`: no wildcard or
directory entries, and every target under `./dist/` except a `core-source`
target, which stays under `./src/`, and the `./package.json` entry, which
exports the manifest itself for tooling and is not a code entry point. It is either `private: true` or carries
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
Declaration maps may resolve only to their shipped, tracked source and adjacent
declaration. It refuses JavaScript source maps, other source-map references,
build-machine home paths, and
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
Two store-vocabulary categories, `store-0` and `store-1`, are counted in Markdown
by the ratchet script itself rather than the pinned scanners, so reader pages
start at zero. A store category that no accepted baseline row carries yet may be
seeded once, up to the counts measured on the base tree and never from the
candidate; after that it ratchets like every other category.

The root `ROADMAP.md` provider matrix has a scoped exception in the existing
opt-in adapter vocabulary allowances: at most two matches each for categories
`ui-12`, `ui-13`, `ui-14` and `ui-15` at that exact path. A third match, those
terms at other paths outside their existing adapter allowances, and every other
counted term or category remain checked. The baseline and scanner pins stay
unchanged. The neutrality CLI witnesses cover the current matrix and these
refusals.

Pinned SQL vocabulary exceptions and their compatibility limits are owned by
[Data and migrations](docs/platform/DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards).

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
or response bags. The focused glue tests do not replace the actual fulfillment conformance
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

For SQL history, forward admission, expression classification and approval pins,
follow [Data and migrations](docs/platform/DATA_AND_MIGRATIONS.md). The required
self-check and release checks use those same contracts.

Before pushing a SQL, migration or registry change, run `npm run sql:admit` after
`git fetch origin`. It dry-runs the hosted admission locally: the self-check's
forward admission and append-only history on `origin/main` and a temporary pull-request
merge, and the queue's co-located approval guard on the fork point and on that merge.
It checks committed revisions only: `--head <rev>` defaults to `HEAD`, against
`--base <rev>` (default `origin/main`). Commit first; a local commit can be amended.
Without an explicit `--head`, any uncommitted change exits 2 with a "not checked"
message and no PASS. With explicit `--head`, only that commit is checked.
The command prints PASS or REFUSED per added forward and check with a capability
hint. Object content, refs, index and worktree stay unchanged, but Git may refresh
existing objects' timestamps. Every Git call uses a closed environment.
Hosted CI judges with the merge commit's admission code and the queue
with main's, so the command exits 2 when the code it loads differs from the base; merge
`origin/main` first, or pass `--allow-stale-rules` to run it with a warning. A PASS does
not cover `npm run oss:published-tree -- --policy` and `-- --inventory`, the neutrality
ratchet, the root test suite (including the real-PostgreSQL native catalogue test) or
pgTAP. Hosted CI and the merge queue remain authoritative.

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
The required `test` aggregate exposes root and `pgtap` failures. They do not suppress tests or normalize exits. Installation, database
start/replay/cleanup and unexplained new failures block delivery; naming those
failures does not waive broken CI. Use the hosted pull-request run's raw logs
for this comparison, or the corresponding local commands. The six existing required contexts retain
their coverage, with blocking lint and neutrality. Promoting diagnostic jobs to
required checks is the maintainer's ruleset decision; this contribution changes
no repository settings. Release workflows still check those six contexts, so a
red root suite or `pgtap` run now refuses release through `test`.

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
repins cannot authorize earlier SQL. A change to the validator or other admission
machinery still lands first as its own change. Batched pins land per rail as a prefix in version
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
`config/openlup-publication-catalog.json`, except two patterns: the fragment
pattern `packages/{core,outbox,platform}/changes/*.md` and the reader guide
`packages/core/docs/guide/**/*.md`. Both are admitted as `public-output` only
after content and regular, non-executable mode validation. Fragment nesting,
guide directories that are not lowercase, other extensions and per-file rows for
either pattern refuse. The catalogue remains an explicit classification and
execution inventory, not a generated list. A guide page keeps a review floor of
one, like a rule file, because it ships to npm and the website unchanged.

For a notable package change, add a uniquely named
`packages/<core|outbox|platform>/changes/<change>.md` fragment instead
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

If independent-review capability or upstream write authority is unavailable,
hand the authorized local work and task evidence to an authorized supervisor.
Include scope and delivery limits, full base/head SHAs, changed paths, check
commands and exits, and unresolved evidence. Do not invent a receipt or claim
hosted admission from local results. The supervisor follows the sequence below.

## Deliver a change

Follow this sequence within the accountable human's actual submission and merge
authority. Review evidence grants no merge, release, settings or credential rights.
Prefer deleting a rule to adding one: a new control needs a concrete failure
that required CI and the change's own review would miss.

1. **Branch and worktree.** Start from fresh `main` in a dedicated task worktree;
   use the configured repository helper, or ordinary `git worktree`. Continue in
   an already assigned task worktree and leave other tasks' worktrees alone.
   Stacking on a predecessor branch is optional: the lead chooses it for a real
   dependency when it makes the work faster; otherwise branch from `main`.
   For a stack, export `OPENLUP_STACK_BASE=<full-predecessor-SHA>` before native
   `prepare`/`record`/`verify`. The pin must lie between the fork point and HEAD.
   Admission waits until that exact predecessor reaches `main`; its landing
   preserves the unchanged upper candidate's review. An independent PR needs no pin.
2. **Implement, test and document in the same PR.** Implement the change, add
   tests, and update the documentation it makes stale; this is implementation
   work, and the reviewer checks it. Locally run only the tests being written,
   root test files with `npm run test:hosted -- <files>`, `npm run lint`, and
   `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression`.
   Before `prepare`, run `npm run preflight` and have it green, or explain each
   `WARN` in the task record. Full local verification is optional.
3. **Describe the task in the PR description.** Record the finite outcome, scope
   and exclusions, acceptance criteria, risk, actual delivery authority and
   evidence. Keep this record current through fixes and handoffs.
4. **Sign, push and open ready for review.** Commit with DCO sign-off, push and
   open the ready pull request within submission authority. End its description
   with the author's `Signed-off-by:` line: the queue uses it as the merge-commit
   message, and DCO checks merge commits too. Hosted CI on the integration merge
   ref is the required verification.
5. **Prepare native review.** Give fresh-context reviewers the approved criteria,
   exact diff, sufficient source context and open finding cards, without author
   conversation or other reviewers' verdicts. The floors are:

   - one reviewer by default;
   - two for SQL and migrations, money and payments, authorization and permissions,
     security, and admission or review machinery. Declare `behavior` risk at
     `prepare` for money, payments, authorization, permissions or security; the
     tool enforces two for its protected paths and for file-mode changes;
   - zero (CI only) for Markdown changes outside the rule files;
   - one for rule files: `CONTRIBUTING.md`, `AGENTS.md`, the agent guide,
     `.github` policies and agent instruction files. Admission or review machinery
     retains its higher floor.

   A blocker is a correctness or security bug, or a direct contradiction of the
   rules or acceptance criteria. A fail-closed edge case, style or wording is
   advice and never blocks. By default, counted reviews use a fresh local CLI
   reviewer (for example Codex) through the qualified route below; the lead
   coordinates, checks results and decides. The lead chooses reasoning effort by
   task complexity. This assignment is a default, not a fixed rule.
6. **PASS: receipt, auto-merge, queue.** Once `verify` reports `reviewed`, post the
   receipt as a PR comment, then request auto-merge once within merge authority.
   Pending checks may finish afterwards; required source and group checks must
   pass before the queue merges. Confirm the merge on `main`.
7. **FAIL: one fix commit.** Commit the fix, then review only that fix as a delta,
   with the open finding cards, at the same floors above. This needs the failed
   candidate to have had its full floor of complete reviews; after a FAIL from
   delta reviews only, the next candidate takes a full review. Close every
   blocking finding explicitly and return to PASS when review succeeds.
8. **When main moves.** With no conflict, do nothing: the review carries over and
   does not expire. On a conflict, merge `origin/main`, resolve it and review only
   the resolution; verified derived carriers retain coverage as described below. Post a receipt for the resulting head. Never force-push or
   rebase a reviewed candidate.

For a repository whose `origin` tracks OpenLup, ordinary worktree setup is:

```sh
git fetch origin main
git worktree add -b my-change ../openlup-my-change origin/main
cd ../openlup-my-change
```

In a fork, use the remote tracking `https://github.com/openlup/openlup.git` for
fresh main. The review commands use `origin/main` as the local main reference.

### Derived landing carriers

From a clean committed task checkout, refresh the remote reference, then run:

```sh
git fetch origin main
npm run landing:merge
```

The helper merges the exact fetched `origin/main` with DCO sign-off; it never
rebases or pushes. Configure your Git `user.name` and `user.email` before running
it: the merge uses that identity and `-s` for your personal
[DCO certification](#developer-certificate-of-origin).
It stops on an authored conflict, leaving the merge for a
human or worker. Append-only migration entries are unioned in slot order;
existing entries cannot be edited and new duplicate slots refuse. Issued
prefixes retain their original order. The publication catalogue's authored path
rows retain the existing closed registry union.

Integration proof classifies an exact merge of the reviewed head and a commit
on `origin/main` as `derived` only for a closed carrier set: migration registry
unions, the package SQL manifest and selection mirror, publication catalogue,
generated source map and package agent contexts, and the current installation
data file. Trusted owner generators run on a temporary prediction, without
executing candidate tooling or touching the checkout. Output must equal committed
bytes. Every SQL byte and mode must equal the mechanical merge; other changes
remain a `resolution` delta with its existing review floor. Size caps and release
fragments stay reviewed. Generator errors fail closed.

`npm run inventory:refresh` installs all five profiles in disposable local
PostgreSQL through the production migration runner and catalog projectors. It
measures complete hashes, counts, ledger tails and the connected handover count,
and rewrites only `current` in
[the inventory data](tests/postgres/current-installation-inventory.json).
Historical pins remain frozen in the proofs or the `historical` section. Proof
requires the historical section and every byte outside `current` to equal both
parents and the fork point. CI's complete installation assertions independently
check the measured data; review proof does not substitute a guessed measurement.
The canonical manifest's current hashes must match that same data.

A landing containing only these verified carriers needs no resolution review;
a mixed landing reviews only its remaining delta. Existing `git` and
`registry-union` evidence keeps its identity and protected-path vetoes are unchanged.
Stack receipt rules are unchanged.

### Native review and accountability

The qualified route is fresh context, neutral input and read-only review, through
an observed local CLI session or native subagent. Count actual complete results
with distinct context IDs, independent of every author and other reviewer;
a PASS string alone is not execution evidence. The supervisor retains the
observations and checks the reports. No model API, new host or authentication
transfer is required. Receipts are process evidence, not cryptographic remote
attestation or hard signer isolation; Git hashing identifies source objects.

Write ignored `.context/scratch/agent-review/intent.json`:

```json
{ "authorSessionId": "<supervisor session id>",
  "intent": { "risk": "<prose|routine|behavior|unknown>",
    "criteria": "<approved criteria>" } }
```

Keep the intent for the life of the change (later candidates may touch more paths);
changing `risk` or `criteria` requires `prepare --new` and a full review.

Codex may omit `authorSessionId` to use `CODEX_THREAD_ID`. Refresh the local main
reference before preparation so the cheap merge preflight catches known conflicts.

```sh
node scripts/agent-review-session.mjs prepare .context/scratch/agent-review/intent.json
node scripts/agent-review-session.mjs record report.json
node scripts/agent-review-session.mjs verify
```

Each fresh reviewer supplies a complete report:

```json
{ "reviewer": "<observed context id>", "cold": true, "verdict": "PASS",
  "tree": "<reviewed tree>", "documentation": "<claims and related guidance checked; result>",
  "findings": [], "closes": [] }
```

Findings have stable `id`, `summary` and `material` fields; a later report closes
one through `closes: ["<id>"]`. Advice uses `material: false`. The `documentation`
assessment checks stale claims and related examples, including for documentation
changes. Delta reports identify `candidate.coverage.delta` and include
`"ordinary": true`. That digest covers the diff with full object names, so it does
not depend on how many objects the local repository holds. An edge recorded with
abbreviated names before this rule still replays wherever those names reproduce.
Every later preparation keeps the history, so if admission refuses such an edge,
rebuild the session in a clone holding only main and the branch: keep the events
before the refused preparation, repeat each later `prepare` at its recorded head and
record the same reports, each delta report naming its new delta.
State stays in `.context/scratch/agent-review/session.json`;
unchanged preparation preserves evidence and history. `verify` refuses dirty,
mismatched, partial or missing evidence and unclosed blockers. On the CI-only
route no reviewer report is needed. Source admission checks the live head, tree
and floor using trusted main's tooling.

```sh
node scripts/agent-review-session.mjs receipt "$PR" | gh pr comment "$PR" --body-file -
gh pr merge "$PR" --auto --match-head-commit "$REVIEWED_HEAD" --author-email "$AUTHOR_EMAIL"
```

Set `PR` to the PR number, `REVIEWED_HEAD` to the reviewed head SHA and
`AUTHOR_EMAIL` to the maintainer's configured author address. Receipt generation
prints the comment body; posting it is an authorized GitHub write. A new head needs a new
receipt. Hosted admission accepts the newest valid receipt from a user with
write, maintain or admin permission and binds it to the PR head and tree.
Existing receipt formats retain their identities; recorded expiry is not enforced.

### Merge queue

The queue builds and tests the integration tree. A source review carries over
when its base is on main and the group tree is the reviewed tree or the clean
`git merge-tree` result on the queue base. A clean registry-carrier union or verified derived landing also
preserves review; only the remaining resolution needs review. The required checks
on that tree cover interaction with main.

Before each external write, recheck actual authority, the live head and the
applicable receipt. A known failed required check needs diagnosis. Conflicting
mergeability stops enqueue attempts; `UNKNOWN` permits one fresh read, then
diagnosis. Leave `BEHIND` to the queue. Never use `--admin` for this route.
A non-null `autoMergeRequest` means armed; only `mergeQueueEntry` confirms queue
entry. Observe an existing request instead of repeatedly arming it.

Where activated, trusted `Queue Handoff` can insert a still-armed exact head once
after the required source successes and current native proof. It does not arm
an unarmed PR, poll or automatically requeue an evicted head. Its App is scoped
to this repository with no bypass; its private key stays in the main-only
`openlup-merge-queue` environment, separate from release credentials. Queue
Handoff's built-in workflow token is read-only. Activation and settings remain
maintainer actions.

Admission waits up to twenty minutes for a receipt after the six mechanical
checks pass. Where it is activated, a new receipt comment from an owner, member
or collaborator with write, maintain or admin permission starts the trusted
[receipt rerun](.github/workflows/native-review-receipt-rerun.yml). It reruns the
failed jobs once, with the built-in token's `actions: write`, only when the newest
run for the PR's current head, branch and repository is complete and `native-review`
is its only failed job. After an automatic rerun, confirm that the PR entered the
queue: whether Queue Handoff fires for an attempt requested with the built-in token
is unwitnessed until the first hosted rerun. In any other state, after a PR receipt
timeout, submit or check the receipt and rerun the failed `native-review` job within
rerun authority. A group timeout needs a requeue under merge authority. Queue recovery
is bounded at two retries; a second timeout or removal of the same head stops
for diagnosis. A flake requires a passing rerun on the same tree; missing or late
receipts are not flakes. A timely valid receipt rejected without a conflict is
a defect to diagnose.

The admission script comes from trusted main, but the job YAML comes from the
candidate. A successful same-name no-op could bypass admission. Review of changes
to that machinery is the in-repository control; a ruleset-required workflow
pinned outside candidate control requires a separate settings decision.

## Review lessons

Optional references from prior work:

- Cold public-import tests catch initialization lost during extraction.
- Test role restrictions with the granted role; owner access only proves setup.
- Check typed public declarations with the compiler, alongside runtime tests.
- Exercise cleanup through actual subprocess interruption and resource absence.
- Keep canonical contract owners and link related guidance rather than copying it.

## Developer Certificate of Origin

Every commit in a contribution must carry a sign-off:

```text
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds the line. It certifies that you wrote the contribution, or
have the right to submit it under the project licence, and understand that the
contribution and its sign-off are public and permanent. There is no CLA.

To inspect the sign-off range locally (optional):

```bash
npm run check:dco-signoff -- "$(git rev-parse <base-commit>)" "$(git rev-parse <head-commit>)"
```

Published Tree CI validates the same sign-off requirement for each pull-request
commit.

## License

By contributing, you license your contribution under the Apache License 2.0 in
[LICENSE](LICENSE).
