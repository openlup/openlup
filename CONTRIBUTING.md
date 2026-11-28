# Contributing to OpenLup

OpenLup 1.x has a [stable compatibility contract](packages/core/docs/guide/reference/stability.md#public-api).
Contributions preserve that contract and the [support policy](.github/INSTALL_SUPPORT_POLICY.md);
a source checkout alone is not a supported installation.

Start with the [platform documentation](docs/platform/README.md), then read the
[public agent guide](docs/platform/AGENT_GUIDE.md) before changing a platform
boundary. The [governance policy](.github/GOVERNANCE.md) owns contribution
admission, compatibility ownership, and maintainer capacity; accepting a pull
request does not automatically promote its subject to an official module.

For documentation changes, use the short [public writing profile and page
template](docs/platform/README.md#write-or-update-a-page). State which reader
and release or profile it serves, verify commands from the stated working directory,
and separate current behavior from proposals or dated history. Correct the
owning page in the same contribution as a changed public contract; a link check
alone does not establish that an install or feature works.

## Use a package or contribute source

For an application task, start from your application's root with Node 24 and
npm 11.19.0: `npm install --save-exact @openlup/core@<version>`, where `<version>`
is the current set on npm (`npm view @openlup/core version`); install every
`@openlup/*` package you use at that same version. Read the installed
`AGENTS.md` and its [typed wiring example](packages/core/AGENTS.md#wiring-example),
then use the [adopter route](packages/core/docs/guide/start/adopt-from-npm.md). No OpenLup
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
   the eight hosted shards feed the required `test` aggregate.
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

## Add a setting

Place a row in the packaged catalogue when OpenLup owns the installed policy,
the host callback contract, the capability gap or the invariant. Keep the
package's per-kind recipe for its domain data or executable descriptor and
regenerate the carriers. When the application owns a configurable value in its
code, [declare it in its settings binding](packages/core/docs/guide/how-to/operate/configure-settings.md#declare-a-setting-of-your-own)
with the owned file, symbol, goal and effect. Report that file value through the
binding, run the app's startup check, and use its settings script to verify
discovery. Application declarations require no package catalogue edit.

Before adding a configurable setting, confirm it passes all five qualification
tests from [What belongs in settings](packages/core/docs/guide/how-to/operate/configure-settings.md#what-belongs-in-settings):
1. **Business decision** (two honest stores may differ; not a money, integrity, security or legal-evidence guard).
2. **Value, not behavior** (expressible as data consumed by existing code, not new logic).
3. **Known effect** (one sentence covers customer/operator impact and records that keep prior values).
4. **Single value author** (one source of truth; file-to-database feeds must detect drift at startup).
5. **Store level** (store-wide policy, not per-installation infrastructure or per-record data).

Every declared setting must have working consumer code in the scope where it is
declared. Tunable abuse-protection thresholds require an explicit warning in
their effect description (including scope caveats such as per-process memory).
Document platform limits or non-configurable rules as `cap` or `invariant`
entries; keep secrets, ports, low-level technical tuning, brand/copy and
provider selection outside the catalogue.

Every PR adding or changing a business policy, threshold, time window, or
`commerce_settings` key must evaluate it against the five tests and either add
it to the configurator (`settings-data.json` / `settings-host.ts`), record an
explicit exclusion, or plan a scope extension — enforced by `settingsCandidateParity.test.ts` and the `preflight` candidate guard.

For `cap` or `invariant`, add an entry to `packages/platform/src/<domain>/settings-data.json`
and run the same regeneration steps as for installed settings. Include
`key`, `domain`, `kind`, `goal`, `schemaVersion: 1`, a read-only `runtime` with one
`reason`, and `change.reference` for where to act. Omit value fields.

For `callback`, add a value descriptor to the owning domain's `settings-data.json`.
Use `kind: "callback"` and the read-only runtime level. Describe the default,
effect and records that keep existing values. Set `change.reference` to the guide
for the platform callback contract, then regenerate the catalogue as below.

### Kind `installed`

Use [renewal stock protection](packages/core/docs/guide/how-to/operate/settings-catalogue.md#inventory_renewal_protection)
as the discovery example. Ship the domain's setting and its evidence together
when qualifying it for installed runtime use.

1. Describe the default, absence, effect and records that keep their original
   terms using the shared plain-data descriptor type. For an executable
   descriptor, include a schema, named rules, a valid example and a failing
   example per rule.
2. For an installed setting, add the domain's `<key>_validate(jsonb)` forward
   and installer contract, and wire an optional connected reader (and previewer
   where supported) in `packages/platform/src/lifecycle/openlup.mjs` or the
   application's settings binding. Have the SQL reader call that validator. For
   a new SQL-consumed setting, give each new consuming function an optional
   policy argument that defaults to the installed read so preview can reuse the
   computation. Leave existing function signatures unchanged.
3. Use one corpus of inputs, normalized values and refusal codes to check TS
   and PostgreSQL together.
4. Qualify domain preview before opening a runtime write path.
5. Name every TS and SQL consumer. Prove that all use the installed value in
   the same snapshot without a restart before marking the key runtime-ready.
6. Prove absence preserves behavior, refusal happens before a write, completed
   receipts replay, open commitments keep their terms, two sessions cannot
   overwrite one another, and rollback restores both a prior value and absence.
7. Keep an executable descriptor in domain code and export it from the
   smallest existing non-browser entry that needs it. Keep descriptive entries
   in the owning domain's `settings-data.json` for the trusted generator to
   read as private source data. Installed consumers use the packaged catalogue
   for those entries. Build the workspaces, run `node scripts/settings-catalogue.ts --write`
   and update the owner's reader-guide page. The package gate checks that the
   domain data and executable descriptors reproduce the generated bytes.
   Descriptive entries need no generator edit. Add each executable descriptor to
   the list in `scripts/settings-catalogue.ts`, and check or update `searchTerms`
   in `scripts/settings-catalogue.ts` for any new key or domain so goal-based
   discovery finds it.
8. Include each refusal's specific remediation and next command.

Use a neutral default supported by evidence, or record a matching reference-code provenance. Record the exact
commit and file line in the PR task record. Only a verified deployment read can establish a live
basis. Keep market and brand examples in the adopter's files, preserve the
historical result on an absent row, and leave explicit overrides in place.
Changing a fallback is a behavior change. Give it a separate PR, an upgrade
note and an updated absence witness.

Keep rules, defaults, normalization and effect in each domain. The shared
layer owns descriptor transport and discovery.

## Contribution checks

Start from the question you need to answer during implementation:

- **Find the contract owner and source paths:** open the generated [source map](docs/platform/SOURCE_MAP.md) (projected from [`config/doc-routing.json`](config/doc-routing.json)), then read the linked owner page and adjacent tests.
- **Choose and run the right test:** use [Run and inspect](docs/platform/contributing/testing.md#run-and-inspect) and [Choose a location and proof](#choose-a-location-and-proof).
- **Check structural and import boundaries:** use [Commands and lint rules](docs/platform/contributing/ci-checks.md#commands-and-lint-rules).
- **See what each CI or local diagnostic proves:** use the [diagnostic table](docs/platform/DEVELOPMENT_AND_RELEASE.md#what-each-diagnostic-proves).
- **Follow the worktree, preflight, review and queue sequence:** use [Deliver a change](#deliver-a-change).

| Change | Contributor files |
| --- | --- |
| Edit existing behavior | Edit the owning source and its nearest behavior tests. Update reader guidance if the public contract changes. |
| Add or remove a tracked public file | Update the [publication inventory](config/openlup-publication-catalog.json) unless the [publication policy](docs/platform/DOCUMENTATION.md) already admits the file by pattern (`packages/{core,outbox,platform}/changes/*.md`, `packages/core/docs/guide/**/*.md`, or manifest-pinned `db/platform/migrations/*.sql` and `packages/platform/sql/*.sql`). |
| Change an exported contract or add a migration | Follow the owning [package checks](#package-policy-and-release-checks) or [migration workflow](docs/platform/DATA_AND_MIGRATIONS.md) to regenerate affected files. |
| Prepare a release or change repository controls | See [release and repository controls](docs/platform/DEVELOPMENT_AND_RELEASE.md). These are maintainer tasks. |

Release tooling shares one coherent-set version rule: `0.N.P` with N at least
1, or `MAJOR.MINOR.PATCH` with MAJOR at least 1, without leading zeros or a
prerelease. Patch sets compare API snapshots with the latest earlier patch in
the same major and minor; an API change still requires a minor or major set.
Within a stable major, the unprivileged preflight before approval refuses removed
export names against the latest earlier release App tag in that major; a removal
needs a major set.

[Development, diagnostics and preview releases](docs/platform/DEVELOPMENT_AND_RELEASE.md)
explains CI triggers, diagnostics and release mechanics. The linked checks cover
CI and optional full local feedback. Required verification runs in hosted CI under
[Deliver a change](#deliver-a-change).

Use the [source map](docs/platform/SOURCE_MAP.md) to find each changed contract's
owner and nearest tests. Package and installed-consumer checks establish artifact
boundaries; a fixture does not establish hosted qualification or provider access.
For SQL mechanics and migration witnesses, follow
[Data and migrations](docs/platform/DATA_AND_MIGRATIONS.md).

The policy self-check validates local Markdown links and fragments and generated
navigation. See
[Documentation maintenance](docs/platform/DOCUMENTATION.md) for ownership and generation.

### Local stack bases and heavy verification

[Run optional heavy commands against a reviewed candidate](docs/platform/contributing/ci-checks.md#local-stack-bases-and-heavy-verification).

### Optional SonarQube Cloud diagnostics

[Set up and assess the optional SonarQube Cloud pilot](docs/platform/contributing/ci-checks.md#optional-sonarqube-cloud-diagnostics).

### CI image mirror

[See the pinned images, pull fallbacks and maintainer setup](docs/platform/contributing/ci-checks.md#ci-image-mirror).

<a id="development-preview-checks"></a>

### Required and raw checks

[See the required jobs, raw diagnostics and local equivalents](docs/platform/contributing/ci-checks.md#required-and-raw-checks).

### Commands and lint rules

[Run structural, import and neutrality checks](docs/platform/contributing/ci-checks.md#commands-and-lint-rules).

### Test scope and diagnostics

Use the pinned Node version in [.nvmrc](.nvmrc), npm 11.19.0 and the committed lockfile in your task worktree. Run the tests being written locally with `npm run test:hosted -- <files>` for hosted parity. See [required and raw checks](docs/platform/contributing/ci-checks.md#required-and-raw-checks) for hosted CI and optional full local verification.

- [Run and inspect tests](docs/platform/contributing/testing.md#run-and-inspect).
- [Check sufficient evidence and material test gaps](docs/platform/contributing/testing.md#sufficient-evidence-and-material-test-gaps).
- [Keep fixtures deterministic and work fast](docs/platform/contributing/testing.md#keep-fixtures-deterministic-and-work-fast).
- [Separate DB, package and coverage proof](docs/platform/contributing/testing.md#separate-db-package-and-coverage-proof).

#### Choose a location and proof

[Match the test to the owning runner and behavior boundary](docs/platform/contributing/testing.md#choose-a-location-and-proof).

#### Extend tooling selection conservatively

[Update tooling test selection and verify the exclusions](docs/platform/contributing/testing.md#extend-tooling-selection-conservatively).

### Package, policy and release checks

[Check package API, installed artifacts, publication policy and release preparation](docs/platform/contributing/package-checks.md#package-policy-and-release-checks).

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

### Agent coordination harness

[Use the contributor harness for checks, PRs, monitoring and handoffs](docs/platform/contributing/delivery.md#agent-coordination-harness).

## Deliver a change

Follow this sequence within the accountable human's actual submission and merge
authority. Review evidence grants no merge, release, settings or credential rights.

1. **Branch and worktree.** Start from fresh `main` in a dedicated task worktree;
   use the configured repository helper, or ordinary `git worktree`. Continue in
   an already assigned task worktree and leave other tasks' worktrees alone.
   Stacking on a predecessor branch is optional: the lead chooses it for a real
   dependency when it makes the work faster; otherwise branch from `main`.
   For a stack, export `OPENLUP_STACK_BASE=<full-predecessor-SHA>` before native
   `prepare`/`record`/`verify`. The pin must lie between the fork point and HEAD.
   Admission waits until that exact predecessor reaches `main`; its landing
   preserves the unchanged upper candidate's review. An independent PR needs no pin.
2. **Specify before implementing.** Use [Write a change specification](#write-a-change-specification)
   to record the current contract and its acceptance criteria before writing code.
   For SQL, control-path and money changes, have the specification reviewed before
   implementation starts. A capability check that decides whether a command can
   report readiness is a control path, including for a read-only command.
3. **Implement, test and document in the same PR.** Implement the change, add
   or update tests as called for by the [test guide](#test-scope-and-diagnostics),
   and update the documentation it makes stale. The reviewer checks this work.
   Locally run only the tests being written,
   root test files with `npm run test:hosted -- <files>`, `npm run lint`, and
   `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression`.
   As the standard pre-push gate (and before `prepare`), run
   `npm run preflight -- --affected` (or default `npm run preflight` when full
   area/smoke coverage is needed) and have it green, or explain each `WARN` in
   the task record. Full local verification is optional.

   A PR that adds or changes a starter-owned file or its owned-file contract must
   include the packaged starter migration in a Core fragment and matching steps
   in `scripts/packages/distribution-cli-proof.ts`, with regression evidence in
   its test. Describe pristine replacement, customized reconciliation, startup
   refusals and any explicit installed-policy step. Release preparation consumes
   the fragment into the next reader upgrade guide. Leave released sections intact.
4. **Describe the task in the PR description.** Use the specification as the
   task record. Include its acceptance criteria, risk, actual delivery authority
   and observed evidence. Keep the record current through fixes and handoffs.
5. **Sign, push and open ready for review.** Commit with DCO sign-off, push and
   open the ready pull request within submission authority. End its description
   with the author's `Signed-off-by:` line: the queue uses it as the merge-commit
   message, and DCO checks merge commits too. Hosted CI on the integration merge
   ref is the required verification.
6. **Prepare native review.** Give fresh-context reviewers the approved criteria,
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

   A blocker is a correctness or security bug, or a material contradiction of the
   rules or acceptance criteria. Behaviour unchanged from the base is not a
   finding of this change; record it as advice and a follow-up. A refusal stricter
   than the criteria is advice unless it refuses a released or documented valid
   input or has another material effect, such as a wrong-fix error. A finding
   against a document outside the tree (brief, specification, PR body, criteria
   wording) is advice to the lead; the reviewed tree keeps its reviews. Material
   findings include wrong published effects or persisted data,
   a released-API change, a security defect, and an unactionable or wrong-fix
   error; these stay blockers in every round.

   Treat unjustified adopter-visible concepts or steps, leaked internals and
   unactionable errors as material findings that block. State the concrete cost.
   Style or wording alone is advice. Reading the wrong store or reporting success
   for a refused input in a read-only command is a wrong published effect.
   By default, counted reviews use a fresh local CLI
   reviewer (for example Codex) through the [qualified route](#native-review-and-accountability); the lead
   coordinates, checks results and decides. The lead chooses reasoning effort by
   task complexity. This assignment is a default, not a fixed rule.
7. **PASS: receipt, auto-merge, queue.** Once `verify` reports `reviewed`, post the
   receipt as a PR comment, then request auto-merge once within merge authority.
   Pending checks may finish afterwards; required source and group checks must
   pass before the queue merges. Confirm the merge on `main`.
8. **FAIL: one fix commit.** Commit the fix, then review the cumulative delta
   since the last candidate with its full floor of complete reviews, with the
   open finding cards, with one cold reviewer (the prior reviewer may return), or take a full review if no such
   candidate exists, the base, intent, or author changed, or the repair history
   is no longer linear and merge-free. A new protected path or mode change keeps
   the two-reviewer floor; ordinary Markdown alone needs no delta reviewer. Close every blocking finding explicitly
   and return to PASS when review succeeds.

   Count every review round. A repair cycle fails to converge if a finding of an
   already-seen class reappears on another path, the number of material findings
   fails to fall, or the repair introduces a regression. After two consecutive
   non-converging cycles on the same change, stop repairing and regroup. Get an
   independent design analysis from fresh context that identifies the component
   owning each violated invariant, the root cause per class, the smallest design
   that makes each class impossible on every path, what survives, a PR split sized
   for review and the DX impact. Take any change in scope, design or contract to
   the accountable human before implementing the regrouped approach once. If it
   still fails on a material finding, stop and give the accountable human options.
9. **When main moves.** With no conflict, do nothing: the review carries over and
   does not expire. On a conflict, merge `origin/main`, resolve it and review only
   the resolution. [Verified derived carriers](#derived-landing-carriers) retain
   coverage. Post a receipt for the resulting head. Never force-push or
   rebase a reviewed candidate.

When a change merges or stops, add a one-line self-retro to the task record with
the measured delay or defect, the simplification found, or `none`.

For a repository whose `origin` tracks OpenLup, ordinary worktree setup is:

```sh
git fetch origin main
git worktree add -b my-change ../openlup-my-change origin/main
cd ../openlup-my-change
```

In a fork, use the remote tracking `https://github.com/openlup/openlup.git` for
fresh main. The review commands use `origin/main` as the local main reference.

### Write a change specification

[Write and verify the change specification](docs/platform/contributing/delivery.md#write-a-change-specification).
[Trace changes that cross a contract boundary](docs/platform/contributing/delivery.md#changes-that-cross-a-contract-boundary).

### Derived landing carriers

[Synchronize and verify derived files, migration slots and landing resolutions](docs/platform/contributing/delivery.md#derived-landing-carriers).

### Native review and accountability

[Prepare, record and verify native review and its receipt](docs/platform/contributing/delivery.md#native-review-and-accountability).

### Merge queue

[Check authority, arm the reviewed candidate and observe queue admission](docs/platform/contributing/delivery.md#merge-queue).

## Review lessons

Optional references from prior work:

- Cold public-import tests catch initialization lost during extraction.
- Test role restrictions with the granted role; owner access only proves setup.
- Check typed public declarations with the compiler, alongside runtime tests.
- Exercise cleanup through actual subprocess interruption and resource absence.
- Keep canonical contract owners and link related guidance rather than copying it.
- State every exclusion and definition the lead already knows in the review criteria,
  including which released history stays byte-identical, how measurements are defined,
  and which artifacts are required. Omissions have caused avoidable failed reviews.

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
