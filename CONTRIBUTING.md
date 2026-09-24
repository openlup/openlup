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
six required jobs of [Published Tree CI](.github/workflows/published-tree-ci.yml)
run; each comment names its job:

```bash
npm ci
# dco (needs no install): the commits your branch adds to origin/main
npm run check:dco-signoff -- "$(git rev-parse origin/main)" "$(git rev-parse HEAD)"
# typecheck
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
# gitleaks 8.30.1, as CI pins it, over the checkout's history
gitleaks git . --config config/gitleaks.toml --redact --no-banner
```

The three `oss:published-tree` modes are distinct checks. `--policy` verifies
the public policy and catalogue boundary, `--inventory` verifies the selected
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
`guard:public-reference-site-routes`, `oss:published-tree`, `packages:check`,
and `test`.
`npm run build` is the public build truth; its public-reference subcommands and
guards are internal links in that bounded chain. Published Tree CI invokes the
build, scoped tests, DCO check, and publication checks from this inventory.
Adding or renaming any source package command requires reclassifying the whole
source command-name inventory before a new preview can be materialized.

The projected `npm test` command owns the canonical whole-directory public test
scope, and [Published Tree CI](.github/workflows/published-tree-ci.yml) invokes
that command without restating the directories. Run `npm test` for the public
suite and narrower paths from that scope while iterating. The root Vitest
configuration does not collect the standalone `packages/core` test suite just
because the root command names that directory. From the repository root, run
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
which are outside that root command's scope.

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

No hosted job and no command above runs these test classes (measured on `main`
at `f09d865`, 2026-09-23):

- 1,256 of the 1,622 test files the root Vitest configuration collects
  (`npx vitest list --filesOnly`); the `test` job runs the other 366. They are
  outside the public test scope, and their status is unmeasured. They include
  the 3 files in `tests/postgres/`, 2 of which need Docker.
- The 204 pgTAP files in `supabase/tests/`; no repository command runs them.
- The 6 root Playwright configurations; 5 of them match no spec
  (`npx playwright test --list --config <file>`).
- The UI package's neutrality check,
  `node --experimental-strip-types packages/ui/smoke/neutrality.ts`;
  `packages/ui` is not a root workspace.

Admitting any of them to a hosted job is separate quality work.

A change can be released as the next source preview when the required checks of
Published Tree CI pass and its tree describes itself: the publication catalogue
lists every tracked path, and `config/openlup-source-release-contract.json`
matches the tree's bytes. Adding, removing or renaming a file, changing a mode, a
dependency or a file pinned as projected is releasable on those terms. The release
producer (`scripts/oss-source-release-contract.ts`) still refuses a preview that
changes a platform migration (`db/platform/migrations/**`, `supabase/migrations/**`
or a `.sql` file under `db/bootstrap/`), `config/platform-migration-manifest.json`,
the database schema types (`src/integrations/supabase/types.ts`) or the policy
registry (`config/openlup-policy-registry.json`), or that adds a public path at a
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
