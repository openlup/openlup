# Contributing to OpenLup

OpenLup is in development preview. Contributions are welcome, but a source
checkout is not yet a stable framework release, a supported installation, or an
upgrade contract. The later `P1-SF` gate owns those commitments.

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

## Contribution shape

Use a dedicated task worktree and branch for implementation; the coordination
checkout stays clean. Claude and Codex create that isolation automatically with
the configured repository helper before task edits, installs or tests. Continue
in an already assigned task worktree and leave other tasks' checkouts alone.

Record the outcome, scope, authority, acceptance, risk and execution/proof plan
compactly. Small tasks need no separate planning ceremony or specification.
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

## Development-preview checks

Use the Node version recorded in [.nvmrc](.nvmrc), npm 11.19.0 (the
`packageManager` field of `package.json`), and the committed npm lockfile. From
the root of a materialized development-preview tree, these are the commands the
seven jobs of [Published Tree CI](.github/workflows/published-tree-ci.yml)
run; each comment names its job:

```bash
npm ci
# dco (needs no install): the commits your branch adds to origin/main
npm run check:dco-signoff -- "$(git rev-parse origin/main)" "$(git rev-parse HEAD)"
# typecheck
npm run lint
npm run oss:published-tree -- --typecheck
# install-proof (CI installs with: npm ci --prefer-offline --no-audit --fund=false)
npm run build
OPENLUP_REFERENCE_PROFILE=subscription OPENLUP_BUILD_OUT_DIR=dist-subscription \
  OPENLUP_SSR_OUT_DIR=dist-subscription-ssr npm run build:public-reference
# test
npm test
npx vitest run server/runtime/public-reference \
  src/pages/account/v2/subscriptions/modals/RescheduleModal.test.tsx
npm --workspace ./packages/core run ci
npx vitest run scripts/oss-published-tree-check.test.ts
# self-check (needs no install)
npm run oss:published-tree -- --policy
npm run oss:published-tree -- --inventory
node scripts/public-ci-neutrality.mjs
node --experimental-strip-types packages/ui/smoke/neutrality.ts
# pgtap (Docker and Supabase CLI 2.98.2 required)
node scripts/public-ci-pgtap.mjs
# gitleaks 8.30.1, as CI pins it, over the checkout's history
gitleaks git . --config config/gitleaks.toml --redact --no-banner
```

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

The complete projected root command inventory is `build`,
`build:public-reference`, `build:public-reference:client`,
`build:public-reference:prerender`, `build:public-reference:ssr`,
`check:dco-signoff`, `guard:client-secret-boundary`,
`guard:public-reference-site-routes`, `lint`, `oss:published-tree`,
`packages:check`, and `test`.
`npm run build` is the public build truth; its public-reference subcommands and
guards are internal links in that bounded chain. Published Tree CI invokes the
build, complete root tests, DCO check, and publication checks from this inventory.
Adding or renaming any source package command requires reclassifying the whole
source command-name inventory before a new preview can be materialized.

`npm run lint` runs ESLint over the tree, including the import boundaries in
[eslint.config.js](eslint.config.js): a package under `packages/` imports
nothing outside its own directory, other code reaches a package only through
the subpaths its `exports` declare, and domain code under `src/domains` and
`server/domains` imports no provider SDK and no adapter, infrastructure,
runtime or route code. Published Tree CI runs it in the `typecheck` job.

The projected `npm test` command owns the complete root Vitest test
scope, and [Published Tree CI](.github/workflows/published-tree-ci.yml) invokes
that command without restating the directories. Run `npm test` for the public
suite and narrower paths from that scope while iterating. The root Vitest
configuration does not collect the standalone `packages/core` test suite with the root configuration. From the repository root, run
`npm --workspace @openlup/core run ci` for that package's separate checks
(equivalently, use its local command from the package directory). Published Tree CI
invokes this package command separately, including its coverage, release gates and
packed-consumer checks. A green root suite alone still does not prove those checks.
CI also builds the opt-in subscription profile and runs its runtime composition
tests plus the existing renewal modal tests. The disposable database and browser
journey has its own evidence; a build or mocked test does not stand in for it.
The root test command also includes the source release transport/producer
falsifiers and the package release-shape checks under `scripts/packages`. The
public test job separately runs the materialized command-contract falsifiers,
which also run in the complete root scope.

`npm run packages:check` checks every `packages/*/package.json` against
[`config/openlup-packages.json`](config/openlup-packages.json), which lists each
package as released or as unreleased. A released package has the one lockstep
version, exact pins to other released `@openlup/*` packages, registry semver
ranges for every other dependency, and curated `exports`: no wildcard or
directory entries, and every target under `./dist/` except a `core-source`
target, which stays under `./src/`. It is either `private: true` or carries
exactly the public, provenance-backed `preview` publication settings and a
`repository` entry. An unreleased package is always `private: true`.

`npm run packages:check -- --pack` also builds and packs each released package
into a temporary directory, from a package directory with no uncommitted
changes. Every packed file must be either a tracked file of that package, byte
for byte (the manifest included), or built output of a tracked non-test source.
It refuses source maps and source-map references, build-machine home paths, and
the operational coordinates the public detector knows. It prints each tarball's
integrity. `-- --out <dir>` implies `--pack`. It keeps each publishable
package's tarball in an empty directory, with a `packages-manifest.json` of
their digests. `-- --release-tag openlup-source-preview/<n>` requires the lockstep
version to be `0.<n>.0`. The command publishes nothing; the package preview
channel in [`.github/VERSIONING_AND_EOL.md`](.github/VERSIONING_AND_EOL.md)
describes how a publication is staged.

The root test command has no directory or file filters. It collects the shipped
Node and DOM tests under `api`, `mcp`, `scripts`, `server`, `src` and `tests`,
including `src/lib/*Boundary*` and `*Guardrails*`. Playwright specifications
retain their separate browser/profile runners; the root Vitest command does not
claim browser journey evidence.

The `pgtap` job uses Supabase CLI **2.98.2** and a fresh local database stack,
replays the shipped managed baseline and every published forward in filename
order, with its public prerequisite SQL, then runs
all `supabase/tests`. It stops only its own project in a `finally` block. It
never links a hosted database or installs application seed data. Transaction-scoped
test fixtures declare their synthetic providers, inventory and controls explicitly.
The wrapper supplies their settlement parameters from the public example profile;
it does not load ambient deployment configuration. Run
`node scripts/public-ci-pgtap.mjs` with Docker and the pinned CLI locally.

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

The pull request introducing the widened jobs records the measured known-red
files, reasons and their triage owner. It does not suppress tests or change
failure exit codes. Making these checks required is the maintainer's ruleset
decision; code changes do not change those settings.

Documentation falsifiers are imported by the existing materialized
command-contract test entrypoint. Run
`npx vitest run scripts/oss-published-tree-check.test.ts` for routing, source-impact,
bare-runtime CLI and bundle corruption cases. Those tests create disposable Git
fixtures; they do not publish or validate the meaning of arbitrary prose.
See [Documentation maintenance](docs/platform/DOCUMENTATION.md) for regeneration,
exact comparison bases and clean versus local-draft exports. The public self-check
uses Node built-ins and repository code without installing dependencies.

A change can be released as the next source preview when the required checks of
Published Tree CI pass and its tree describes itself: the publication catalogue
lists every tracked path, and `config/openlup-source-release-contract.json`
matches the tree's bytes. Adding, removing or renaming a file, changing a mode, a
dependency or a file pinned as projected is releasable on those terms. The release
producer (`scripts/oss-source-release-contract.ts`) admits additive forwards under
[Data and migrations](docs/platform/DATA_AND_MIGRATIONS.md#additive-forward-release-path).
It refuses edits or deletions of migration history, non-expand-only SQL, a
non-prefix portable manifest, bootstrap SQL changes, database schema types
(`src/integrations/supabase/types.ts`), policy registry changes
(`config/openlup-policy-registry.json`), or a public path at a
local-measurement selector of the latest preview's `openlup-source-receipt.json`
release asset. Such a change can be merged, but say so in the pull request. To list
those selectors, run
`jq -r '.drift[] | select(.class == "local-measurement") | .selector' openlup-source-receipt.json`
on that asset. [Versioning and EOL](.github/VERSIONING_AND_EOL.md#publish-refuse-and-recover)
states the complete rule.

A new or renamed path also needs its row in
`config/openlup-publication-catalog.json`. After changing that catalogue, a
`package.json` or a `package-lock.json`, regenerate the contract from the
repository root and commit the result:

```bash
node --experimental-strip-types --input-type=module - <<'NODE'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SOURCE_RELEASE_CONTRACT_PATH, deriveSourceReleaseContract } from './scripts/oss-source-release-contract.ts';
const { contents } = deriveSourceReleaseContract((path) => existsSync(path) ? readFileSync(path) : undefined);
writeFileSync(SOURCE_RELEASE_CONTRACT_PATH, contents);
NODE
```

The snippet keeps the contract's identity and `compatibility` and rewrites its
digest fields; on an unchanged tree it rewrites the same bytes. The release
producer enforces the complete self-consistency, byte for byte, when a preview is
cut. CI checks only part of it: `npm run oss:published-tree -- --inventory`
compares several digest values with the tree, but not `inventory.classDigest`
and not the contract's bytes.

The [install support policy](.github/INSTALL_SUPPORT_POLICY.md) and
[publication completeness policy](.github/PUBLICATION_COMPLETENESS.md) describe
what the preview can and cannot demonstrate. They do not turn a preview checkout
into a stable or supported artifact.

## Pull requests

The [autonomous delivery plan](docs/platform/plans/autonomous-reviewed-delivery.md)
uses the supervisor in the current conversation to launch independent
fresh-context subagents under the existing subscription. The maintainer controls
scope and delivery authority without reading every diff or transferring prompts,
reports or authentication between sessions. The same contract applies to Codex,
Claude Code and future agents; no model API, backend or new host is required.

Use one bounded review for ordinary prose, two for behaviour, executable
instructions, contracts, controls and unknown risk. Review the exact final
committed candidate without author history or another reviewer's verdict.
Record actual platform execution observations and complete findings. After
repairs, commit and obtain fresh review. Handle `needs_agent_review` automatically
within the active task and retry the gate; do not ask the owner to reapprove the
same authorized behaviour.

`scripts/agent-review-session.mjs` binds process evidence to the candidate,
intent, scope and reviewer results. Installed verify and pre-push must refuse
missing, stale, partial or unresolved evidence; live enforcement is claimed only
after installed refusal tests pass. These receipts do not cryptographically
attest remote agent execution or establish hard author/signer OS separation.
The merged authenticated verifier/controller and hosted observer remain optional
libraries, not requirements for an external model service. Existing mechanical
checks, DCO and applicable publication/merge authority remain required.

Reuse the compact task record in the PR description instead of writing another
manual. Explain material deviations, evidence and remaining limitations. Review
must assess correctness, approved scope and whether unnecessary complexity adds
maintenance cost; findings need a concrete mechanism and effect, not a quota.

Include the affected documentation owners and what changed in their explanations.
For a scoped no-impact record, challenge its reasoning as well as its fresh
fingerprint: a hash identifies the delta and owner text, not semantic correctness.
Keep generic corrections upstream; separately owned applications document their
selected immutable release and own composition. Their private operations and
adoption state are not public platform documentation inputs.
Read the [AI contribution policy](.github/AI_CONTRIBUTION_POLICY.md) before
submitting material AI-assisted work. Human accountability and DCO, independent
native review, and actual task publication authority remain required.

Use one concern per pull request. Describe the problem, the public contract that
changes, compatibility implications, and the checks you ran. Keep adopter-owned
brand, content, catalogue, local policy, and business-specific integrations out
of generic platform changes unless the proposal explicitly establishes a public
extension seam and a compatibility owner.

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
