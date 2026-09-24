# Versioning and end of life

## Two release channels

OpenLup separates **development preview** from **stable**. An immutable preview
identity makes an artifact reproducible; it does not make that artifact stable
or supported.

- **Development preview** is the current channel. It is for evaluation and
  first-party integration evidence, has no support window, and may contain
  incompatible changes. Every incompatible preview must name the affected
  contract and give explicit upgrade notes in that preview's release notes.
  Silent preview breakage is a defect.
- **Stable** begins only after the `P1-SF` stable-framework gate has produced a versioned platform
  release/BOM, a thin adopter app, public extension contracts and upgrade
  tooling, with the advertised clean install, typecheck, build, tests and
  upgrade proofs green. No current source checkout, private package, or preview
  release satisfies that gate.

## The public compatibility contract

Compatibility is decided by what an adopter consumes, not only by what a package
exports. The public contract includes all of these surfaces when they are
declared public or shipped by an official-stable/core module:

- package export names, types, call shapes, documented behavior and error codes;
- domain and runtime event names, payloads, ordering and delivery semantics;
- extension, module, adapter, registry and capability identifiers;
- public HTTP routes, methods, request/response shapes and error vocabulary;
- configuration keys, schemas, defaults and documented environment behavior;
- migration identifiers, ordering, ledger semantics and the compatibility of
  code with the expanded database schema during an upgrade.

The exported contract snapshot is evidence for the package-export part of this
contract, not a way to declare the other surfaces internal. A surface explicitly
marked experimental follows preview rules. An undeclared implementation detail
may change in any release, but maintainers may not turn a documented adopter
dependency into an internal merely to avoid a compatibility obligation.

## Stable semantic versioning

Stable releases follow semantic versioning across the whole public compatibility
contract.

- **Major** - may complete a previously announced removal after the deprecation
  bridge below.
- **Minor** - additive contracts and deprecations. A breaking change never ships
  in a stable minor.
- **Patch** - fixes with no intentional public contract change.

A stable public contract is not removed in the same release that deprecates it.
First ship a working bridge that keeps the old export, event, identifier, route,
configuration or schema behavior available while naming the replacement and
upgrade action. Keep that bridge through at least one supported stable minor,
and remove it no earlier than the next major with explicit upgrade notes. For
database changes this means expand -> compatible deploy -> backfill -> contract;
rollback must remain compatible with the expanded schema and never rely on a
production down migration.

## Support window

Once stable exists, the current **stable** major and the previous **stable**
major, if one exists, are supported. Development-preview trains are never a
previous stable major, regardless of whether their numeric version was `0.x`.
Nothing else is.

| Version | What it receives |
| --- | --- |
| current major, latest minor | fixes, security fixes, new features |
| current major, older minors | nothing - upgrade to the latest minor first |
| previous stable major, latest minor, if one exists | security fixes and critical-defect fixes only, for **six months** after the current major was released |
| anything older | nothing |

A defect report against an older minor of a supported major must reproduce on
the latest minor. Six months after a new stable major is released, its preceding
stable major, if one exists, is end of life and receives no fixes, including
security fixes. Preview `0.x` does not enter that calculation. The published
window is the advance notice; there is no separate end-of-life campaign.

## Exceptional cessation

This file solely owns the cessation trigger and mechanics. If issues go
unanswered for **six consecutive months**, the project enters exceptional
cessation; governance does not define a second trigger. The maintainer records
the decision here and at the top of the README, naming the decision date, exact
end-of-maintenance date and last supported releases. The repository is archived
on or after that date. If no stable channel ever existed, it may be archived as
soon as the six-month condition is recorded.

If maintainership ceases before an advertised stable window can be completed,
the project must not leave a false support claim standing. The record above is
the fail-honest path for the bus-factor-one project described in
`.github/GOVERNANCE.md`; it does not shorten a support window casually, erase
the licence or make an already released artifact unavailable to fork.

## Before stable

The project has not entered the stable channel. No current version is supported,
and the stable support window above does not apply. Preview releases can break,
but they still owe explicit, release-specific upgrade notes; "pre-1.0" is not
permission to make consumers discover a change from a failed build or migration.

## Upgrades

Stable upgrades are supported one major at a time, in order. Skipping a major is
not supported even when it appears to work. Preview upgrade notes describe only
the exact adjacent preview transition they name and do not create a general
support promise. Database schema changes are forward-only; there is no supported
downgrade path, so take a backup you have actually restored from at least once
before upgrading.

## Maintaining source previews

Contributors propose generic changes through public PRs and the DCO/checks in
`CONTRIBUTING.md`. Maintainers release independently of adopter deployments.
Adopters deliberately select updates and retain their private policies, branding
and supported extensions; contributing does not require publishing private history.
The receipt producer publishes the immediately next preview number. A consumer
may instead select a strictly newer immutable preview from an earlier pinned
release. The reader authenticates both release assets, exact receipts, required
checks and the complete Git ancestry between them. This selection rule does not
turn skipped preview notes into a general upgrade guarantee: review intervening
changes and validate the selected update's compatibility before adoption.
DCO checks every main-push commit; the all-zero first push is restricted to one
root. Empty, malformed and unsigned ranges refuse.

Since `openlup-source-preview/2`, `createPlatformBundleIdGuard`
(`packages/core/src/platform-runtime/contracts.ts`) rejects blank or
whitespace-padded configured bundle IDs; that release note carries the upgrade
action. Use the same nonempty, trimmed ID in configuration and the allowed set;
valid adopter-defined IDs remain exact and case-sensitive. A source rule does
not make this a stable API.

### Prepare from public inputs

Use Node 24, dependencies from `CONTRIBUTING.md`, a clean reviewed public commit
and the next annotated preview tag at that exact HEAD.
The preceding release must be immutable with green required checks. The operation
reads public GitHub metadata, branch rules, checks and release assets. Set
`GITHUB_TOKEN` if anonymous access/rate limits are insufficient; no private repo
permission is needed. Keep credentials out of JSON, receipts and logs. Unavailable
API evidence refuses the operation.

Create an external operation JSON with actual paths. Confirm the current release
number first; preview/4 → preview/5 below is an example. The output parent must exist
outside the checkout, with no symlink component. Use `realpath` to obtain its physical
path; `/tmp` below assumes a physical directory, which is not true on every system.

```json
{
  "previousTag": "openlup-source-preview/4",
  "releaseTag": "openlup-source-preview/5",
  "tagMessage": "OpenLup source preview 5.",
  "releaseNotePath": "/tmp/source-preview-5-notes.md",
  "outputPath": "/tmp/source-preview-5-receipt.json",
  "retireProjectedSelectors": [],
  "previousRelease": {
    "releaseTag": "openlup-source-preview/3",
    "assetName": "openlup-source-receipt.json",
    "assetId": 0,
    "assetDigest": "sha256:<preview/3 receipt asset digest>",
    "sourceReceiptDigest": "sha256:<preview/3 source receipt digest>",
    "targetPublicSha": "<preview/3 target commit>"
  }
}
```

The `previousRelease` values above are placeholders; derive the real tuple as
described below. `retireProjectedSelectors` is optional and empty by default; see
[Publish, refuse and recover](#publish-refuse-and-recover) before naming a selector.

Run from the public checkout, passing the operation JSON path:

```sh
node --experimental-strip-types --input-type=module - /tmp/source-preview-operation.json <<'NODE'
import { readFileSync } from 'node:fs';
import { writeDescendantSourceReleaseReceipt } from './scripts/oss-source-release-contract.ts';
import { parseSourceReleaseReceiptEnvelope } from './scripts/oss-consume-github-transport.ts';
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const result = await writeDescendantSourceReleaseReceipt({
  root: process.cwd(),
  previous: {
    repository: 'https://github.com/openlup/openlup',
    releaseTag: input.previousTag,
    assetName: 'openlup-source-receipt.json',
    receiptCodec: parseSourceReleaseReceiptEnvelope,
    token: process.env.GITHUB_TOKEN,
    ...(input.previousRelease ? { previousRelease: input.previousRelease } : {}),
  },
  releaseTag: input.releaseTag,
  tagMessage: input.tagMessage,
  releaseNote: readFileSync(input.releaseNotePath),
  outputPath: input.outputPath,
  ...(input.retireProjectedSelectors ? { retireProjectedSelectors: input.retireProjectedSelectors } : {}),
});
console.log(JSON.stringify({ outputPath: input.outputPath, digest: result.digest, allowlistDigest: result.allowlistDigest }));
NODE
```

The producer authenticates the preceding release and derives identities from actual
Git objects. It returns `receipt`, `contents`, `digest`, reconstructed `allowlist`
and `allowlistDigest`; only the receipt is written externally. Identical Git objects
and inputs produce identical bytes, without timestamps or local paths.

For a preceding descendant, also supply `previousRelease` in the operation JSON.
Every preview after preview/1 is a descendant, so `previousRelease` is required.
Derive this tuple from the authenticator result for that descendant's predecessor:
`releaseTag = result.release.tag`, `assetName = result.release.assetName`,
`assetId = result.release.assetId`, `assetDigest = result.release.assetDigest`,
`sourceReceiptDigest = result.sourceReceiptDigest`, `targetPublicSha = result.targetCommit`.
Persist this public tuple externally; never invent hashes. The producer reauthenticates
it. A preceding root omits the tuple. Existing schema-4 root receipts remain readable;
schema-5 descendants bind release-body, annotated-tag and reconstructed-allowlist bytes.

### Publish, refuse and recover

A descendant preview may add, delete or change paths, modes, package manifests,
lockfiles and projected content when its release commit describes itself. The
producer checks that the publication catalogue lists exactly the commit's Git
inventory, that every changed direct execution entrypoint is registered, that the
policy registry's active paths exist and that the tree's `package.json` files and
their execution surfaces match the catalogue. `config/openlup-source-release-contract.json` must equal
`deriveSourceReleaseContract` (`scripts/oss-source-release-contract.ts`) of the
commit's own bytes, so every digest field describes the tree. The contract keeps
the previous release's `schemaVersion`, `platformMigrationManifest`,
`databaseSchema`, `policy.registryDigest`, `repository` and `release`; the
validator fixes `runtime`, and `compatibility` may change when it validates.

The producer refuses:

- any add, delete, mode or byte change of a schema-bearing path:
  `config/platform-migration-manifest.json`, `src/integrations/supabase/types.ts`,
  `config/openlup-policy-registry.json`, `db/platform/migrations/**`,
  `supabase/migrations/**` and any `.sql` file under `db/bootstrap/`;
- a public path at a `local-measurement` drift selector;
- a previous receipt whose paths or drift rows differ from its own Git objects.

Every previous drift row carries forward. A `projection` row keeps its source side
and takes its public side from the release commit, `absent` when the path was
deleted; a `local-measurement` row is copied unchanged. No row is added. A row is
dropped only when `retireProjectedSelectors` names it: a canonical, sorted and
unique list of previous `projection` selectors, where any other entry refuses.
Naming a selector asserts that its projection no longer applies: the adopting
repository's bytes at that path now equal the public ones. The producer cannot
check that assertion, so the owner names a selector only on the adopting
repository's evidence. The receipt stays schema 5 and records a retirement by the row's absence from `drift`
and from the allowlist's drift selectors. Earlier previews keep the rules they were
produced under. Do not hand-edit receipts to fit; correct the tree, or regenerate
the contract as `CONTRIBUTING.md` describes.

Review the exact note, tag and receipt before obtaining publication authorization.
Local preparation does not publish or update an adopter. Publish the same tag and
receipt asset as an immutable prerelease with the exact note body, then authenticate
the completed release before offering it for adoption. Publish the body from the
same note file the receipt hashed (for example `--notes-file`), never through the
web editor. To check the published bytes, compare
`gh api repos/openlup/openlup/releases/tags/<tag> | jq -j .body | shasum -a 256`
with the hex digest in `disclosure.releaseNote.digest`;
`gh release view --json body --jq .body` appends a newline and will not match.

On refusal, keep the selected version and fix the named mismatch. Recompute after
changed inputs or a dirty/moving HEAD; select a new physical path if output exists
or traverses a symlink. Discard invalid unpublished candidates. Correct published
releases forward: never replace assets, retag or edit the body. Adopters retain
their reviewed update/recovery procedure; no stable or package channel is implied.
The already-published preview/2 cannot be repaired in place. Its source-preview
reader defect was corrected in immutable
[preview/3](https://github.com/openlup/openlup/releases/tag/openlup-source-preview/3),
which permits a consumer pinned to preview/1 to authenticate and deliberately
select that strictly newer preview without first adopting preview/2. Review
both intervening release notes and validate the selected update against the
consumer before adoption. The later
[preview/4](https://github.com/openlup/openlup/releases/tag/openlup-source-preview/4)
has a separate catalog-slug compatibility action. Publication alone updates no
adopter; no preview is a supported upgrade channel.

## Package preview channel

`@openlup/core` is the one publishable package in
[`config/openlup-packages.json`](../config/openlup-packages.json)
(`publish: true`). Its version is `0.<n>.0` for source preview
`openlup-source-preview/<n>`: `0.6.0` rides on preview 6. Before each later cut,
a commit sets the next version in that file, in each listed `package.json` and
in both lockfiles, and regenerates the source release contract; otherwise the
pack job refuses and that preview carries no package. The channel is inert until
the repository variable `OPENLUP_NPM_STAGE` is set to `enabled`.

When a source preview `openlup-source-preview/<n>` is published,
[`.github/workflows/publish-packages.yml`](workflows/publish-packages.yml) works
in two jobs:

1. **pack** checks two things: that the release commit is on `main`, and that the
   six required GitHub Actions contexts passed there. It also requires the
   lockstep version to be `0.<n>.0`. It then runs
   `npm run packages:check -- --out packs --release-tag <tag>`, scans the unpacked
   tarballs with gitleaks, and records each tarball's sha256 and integrity.
2. **stage** runs in the `npm-stage` environment with no checkout. It verifies the
   commit, the version and those digests, then stages each tarball with
   `npm stage publish ./packs/<file> --tag preview --provenance --access public`.
   It authenticates with GitHub's OIDC token as a trusted publisher and uses no
   stored npm token.

A staged version is not public. A maintainer inspects it (`npm stage download`)
and publishes it with 2FA (`npm stage approve`), or rejects it. Every channel
version carries the `preview` dist-tag. The registry gives a new package's first
version the `latest` tag, whatever tag that publish names, and keeps a `latest`
tag on every package, so `latest` points at the first, inert version (setup
step 5) and no channel version moves it before a stable channel exists. A
tarball publish does not take its tag from `publishConfig`, so every manual
publish passes `--tag preview` explicitly, as the stage job does. A package's
`prepublishOnly` refuses `npm publish` from its directory: only a checked
tarball is published. A compromised version is deprecated and fixed forward,
never unpublished.

A release runs the workflow file of its tagged commit, so whoever can create a
preview-named tag on a commit can also change every check in that workflow. The
tag ruleset therefore restricts who may create `openlup-source-preview/*` tags,
besides updating and deleting them. The environment's tag rule limits only
which refs may deploy to it. The gates that hold whatever the tagged workflow
says are the required reviewer of the `npm-stage` environment and the 2FA
`npm stage approve`.

The maintainer sets the channel up in this order, before the variable is
enabled:

1. The `@openlup` scope belongs to the npm organization `openlup`, whose members
   are maintainers with 2FA.
2. The maintainer's npm account requires 2FA for authorization and writes
   (`npm profile enable-2fa auth-and-writes`), and holds no token that bypasses
   2FA.
3. The GitHub environment `npm-stage` exists, with the maintainer as required
   reviewer, no administrator bypass, deployments limited to
   `openlup-source-preview/*` tags, and no secrets or variables. It must exist
   before the variable: a first run would otherwise create it unprotected.
4. The preview tag ruleset restricts tag creation to repository administrators.
5. A trusted publisher can be bound only to an existing package name. For each
   new name the maintainer publishes a placeholder version `0.0.0` by hand with
   2FA and `--tag preview`, outside this workflow, then deprecates it
   (`npm deprecate`).
6. Package access requires 2FA and disallows tokens
   (`npm access set mfa=publish @openlup/core`).
7. The trusted publisher allows staged publication only, without direct
   publish:
   `npm trust github @openlup/core --file publish-packages.yml --repository openlup/openlup --environment npm-stage --allow-stage-publish`
   (npm 11.15 or later; check with `npm trust list @openlup/core`).
8. The repository variable, not an environment variable, `OPENLUP_NPM_STAGE` is
   `enabled`: the pack job reads it before any environment applies.

Before cutting a preview that carries a package, run
`npm run packages:check -- --out "$(mktemp -d)" --release-tag openlup-source-preview/<n>`
on the exact commit to be tagged: the pack job first runs after the preview is
published, when a refusal can no longer be corrected in that preview.

If staging stops partway, reject the versions already staged before re-running
the stage job.
