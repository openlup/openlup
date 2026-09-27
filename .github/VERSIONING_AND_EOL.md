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

## Pending preview upgrade notes: public coordinates

Status: unreleased source change; these notes must accompany the preview that
first includes it. They do not describe an already published preview transition.

Rename every lowercase-prefixed `openlup_` environment key to `OPENLUP_` in an
adopting deployment's configuration. In particular, use `OPENLUP_ENVIRONMENT`,
`OPENLUP_BASE_URL` and `OPENLUP_BFF_BASE_URL`; the previous spellings are no
longer read. Existing `APP_ENVIRONMENT` and `APP_BASE_URL` precedence is unchanged.
The internal provider-attempt namespace constant and test override globals use
`OPENLUP_` too; provider-attempt identifiers retain the same namespace value.

Configure the canonical production hostnames in
`config/site-routes.json.productionHosts`. Live Tpay callbacks and the watchdog's
preview-email production-domain check both use this list. There is no implicit
production domain: an empty list refuses live Tpay callbacks and supplies no
production domains to the email check. Confirm that registered Tpay callback URLs
use HTTPS and resolve directly without redirects. The reference hostname is an
evaluation placeholder, not production configuration.

The unused appRouteMocks fixture is removed; it has no imports in
the public tree. The publication catalogue and source release contract reflect
that deletion. No database schema changes accompany these upgrade actions.

## Pending preview upgrade notes: shared core schemas

Status: unreleased source change; include these actions in the preview that
first carries it. Stock and ATP contracts now use `@openlup/core/inventory`.
ATP no longer inserts an implicit country region. Set server-only
`INVENTORY_REGION` for the admin ATP route or provide an explicit request region;
without either, the optional region stays absent. An explicit request region
wins, and malformed configured regions refuse the route.

Company identity extensions reuse the neutral core input schema and the public
`normalizeCompanyIdentityLookupRequest` export. National tax-id checks and
optional registry fields remain in the extension layer. The core helper is an
additive development-preview API, not a stable contract.

## Pending preview upgrade notes: moved payment and communications modules

Status: unreleased source change; include these notes in the preview that
first carries it. PR #42 moved the payment adapter registry and the newsletter
provider registry from `server/domains/` to `server/runtime/`, and PR #43 moved
the Stripe payment UI from `src/domains/payment/components/` to
`src/checkout/adapters/stripe/`. Each module's tests moved with it. Import the
new paths:

| Old path | New path |
| --- | --- |
| `src/domains/payment/components/PaymentForm.tsx` | `src/checkout/adapters/stripe/PaymentForm.tsx` |
| `src/domains/payment/components/RecoveryPaymentSetupForm.tsx` | `src/checkout/adapters/stripe/RecoveryPaymentSetupForm.tsx` |
| `src/domains/payment/components/StripePaymentStep.tsx` | `src/checkout/adapters/stripe/StripePaymentStep.tsx` |
| `src/domains/payment/components/useStripePromise.ts` | `src/checkout/adapters/stripe/useStripePromise.ts` |
| `server/domains/payment/paymentAdapterRegistry.ts` | `server/runtime/payment/paymentAdapterRegistry.ts` |
| `server/domains/communications/newsletterProviderRegistry` (no re-export) | `server/runtime/communications/newsletterProviderRegistry.ts` |

The neutral types `PaymentFormCopy`, `PaymentFormSettlement` and
`RecoveryPaymentSetupFormCopy` are exported from
`src/domains/payment/paymentFormContracts.ts`. Every old path in the table
except the newsletter provider registry keeps a deprecated re-export of exactly
its previous public bindings, so existing imports still resolve. The re-exports
are removed in `openlup-source-preview/9`; move imports before adopting it.
`server/domains/payment/paymentAdapterRegistry.test.ts` covers only the
re-export; the registry's own tests are in `server/runtime/payment/`. The
newsletter provider registry has no re-export because the preview 6
communications README told adopters to register a provider adapter by editing
that file, and a plain rename lets git carry those edits to the new path.

Forks with local edits: without the re-exports these moves would be renames that
git follows. With them, the old file counts as modified and the new file as
added, so a fork's local edits to an old file no longer follow the move. Port
those edits to the new path. Resolving the conflict with "keep mine" on the old
path silently drops them from the running code, because every caller in this
tree imports the new path. A fork that keeps its own copy of an old file instead
of the re-export also fails the re-export tests, and a kept copy of
`useStripePromise.ts` holds a second Stripe loader cache beside the one the
moved callers use. A fork that appended its own tests to preview 6's
`server/domains/payment/paymentAdapterRegistry.test.ts` merges without a
conflict, and those tests then land in the re-export's test; move them to
`server/runtime/payment/`. In a fork's own code files, a comment line that
starts with `// openlup-remove-before:` is read as a release marker, so do not
use that text for anything else.

Each re-exported name carries a `@deprecated` tag, so an editor marks a named
import from an old path, and each use of an imported value, as deprecated. These
marks are TypeScript language service suggestions only: `tsc`, CI and this
repository's ESLint config do not report them. They do not reach a namespace
import line such as `import * as M from …` or a type reached through it such as
`M.PaymentFormProps`, an `import("…").PaymentFormProps` type query, `export *`
or `export * as` from an old path, or a re-export statement in consumer code.

A `vi.mock` (or any other module mock) of an old path replaces only the imports
that go through that old path. Every caller in this tree, including each
re-export, imports the moved modules at their new paths, so mock a moved module
under `src/checkout/adapters/stripe/` or `server/runtime/` to intercept it. This
applies to every module in the table, not only the one without a re-export, and
a new-path mock also reaches code that still imports through a re-export.

The pull request that removes the re-exports makes these changes together. It
deletes the five re-exports, and with them their removal marker lines, and their
three tests: `src/domains/payment/deprecatedReExportRemoval.test.ts`,
`src/domains/payment/components/deprecatedReExportBindings.test.ts` and
`server/domains/payment/paymentAdapterRegistry.test.ts`. It removes the
publication catalogue rows of those eight files and re-derives the source
release contract. It removes the sentences that name the re-exports, including
the one that begins "Each disables the rule only", from the import-boundary
paragraphs of `docs/platform/ARCHITECTURE_AND_EXTENSIONS.md` and
`CONTRIBUTING.md`, restores "and there are no exceptions" to the architecture
guide's paragraph, and removes the deprecated re-export section of the payment
domain README. It replaces this section with a short upgrade note for
`openlup-source-preview/9`: the old paths no longer resolve, so import the new
paths. That note may keep the move table and the mock guidance, but it names
each old path without a file extension or outside inline code, because the old
files are no longer in the tree. The removal-marker check in the release
tooling, and its description under Maintaining source previews, stay. Until that
change lands, the release refuses to cut `openlup-source-preview/9`.

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

### One-click source preview workflow

Maintainers can cut an adjacent development preview with
[`publish-source-preview.yml`](workflows/publish-source-preview.yml). This
workflow is inert until the repository variable `OPENLUP_SOURCE_RELEASE` is
`enabled`. It runs only when dispatched from `main`, and its sole job waits for
the maintainer's approval in the `release` environment. Dispatching a run is
not publication authorization: the environment approval is the publication gate.

Before enabling it, the maintainer configures every item below:

1. Create the **`release` environment**, with the maintainer as its **only
   required reviewer**, no administrator bypass, and deployments restricted to
   the `main` branch. Leave prevention of self-review disabled if the sole
   maintainer also dispatches the run. Create these protections before enabling
   the variable; an absent environment could otherwise be created unprotected.
2. Register a dedicated **GitHub App release identity**, install it only on
   `openlup/openlup`, and grant repository **Contents: write** and
   **Administration: read**. The read permission checks release immutability;
   the workflow never changes that setting. No agent-linked PAT is used.
3. In the protected `release` environment, set variable
   **`OPENLUP_RELEASE_APP_CLIENT_ID`** to the App's client ID and secret
   **`OPENLUP_RELEASE_APP_PRIVATE_KEY`** to its private key. Only the maintainer
   provisions or rotates these values. Do not place the key in repository-level
   secrets, notes, receipts or logs. The workflow requests a repository-scoped,
   short-lived installation token and the action revokes it when the job ends.
4. Allow the App to create `openlup-source-preview/*` tags in the **tag-creation
   ruleset**. Preserve restrictions on tag updates and deletions in a separate
   ruleset without an App bypass. The workflow refuses an existing tag and
   never retags or deletes one. Main's existing required contexts remain
   `dco`, `typecheck`, `install-proof`, `test`, `self-check` and `gitleaks`.
5. Enable **release immutability** for the repository (or enforce it from the
   organization). The workflow refuses before tag creation and again before
   publication if the setting is not enabled or cannot be read.
6. Permit the workflow's pinned actions, GitHub-hosted runner, and artifact
   attestations under the repository/organization Actions policies. The job
   needs `contents: read`, `checks: read`, `id-token: write` and
   `attestations: write` on its default token. That token cannot create a release.
7. Finally set the **repository variable** `OPENLUP_SOURCE_RELEASE` to
   **`enabled`**. Removing it or using another value disables future runs.
   `OPENLUP_NPM_STAGE`, the `npm-stage` environment and npm trusted-publisher
   setup remain separate; follow [Package preview channel](#package-preview-channel)
   to enable package staging after a source release.

In Actions, choose **Publish Source Preview → Run workflow**, select **main**,
and enter the reviewed full lowercase **target commit SHA**, immediately next
**preview number N**, and **exact release note body**. Read that body and the
target diff before approving the `release` environment. Include the adjacent
preview's upgrade actions and any applicable pending notes from this document.
If a future release policy defines a release-semantics block, include that block
in these same note bytes; this document currently defines no such block.
Confirm the package version `0.<n>.0` and its pack proof before approving a
preview that should stage packages.

The job repeats the package workflow's main-ancestry and six required-context
check at the target. Its prepare step refuses preview N, before any tag exists,
while a code file (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.mts` or `.cts`)
anywhere in the target's tree has a removal marker naming preview N or an
earlier one, or a marker line that does not parse, and names each such file; the
receipt producer repeats the check. A removal marker is a whole `//` comment
line of the form `openlup-remove-before: openlup-source-preview/<m>`, and any
comment line starting `// openlup-remove-before:` must parse as one. Only a NUL
byte in a file's first 8000 bytes makes it binary and skips it; attributes do
not. It authenticates the preceding release and its predecessor, deriving the
`previousRelease` tuple from the authenticator rather than an operator JSON. It
then creates the annotated tag with exactly `OpenLup source preview N.`, runs
the existing descendant receipt producer without selector retirements, and
attests `openlup-source-receipt.json`. The producer's schema, catalogue,
contract and projection refusals are unchanged.

The App creates a **draft prerelease**, uploads the attested receipt, and checks
the draft's exact body and asset digest against the prepared bytes before
publishing it. Both creation and publication use the same saved note file.
Publication makes the prerelease immutable. The App token emits the release
event that starts `publish-packages.yml`; the default `GITHUB_TOKEN` would
suppress that downstream workflow. The final step authenticates the completed
immutable release, target SHA and receipt asset. Package staging still needs its
own enabled variable and human approval; a source release changes no deployment.

A failed run never automatically deletes a tag or draft, replaces an asset, or
edits a published release. An abandoned tag/draft blocks the next attempt.
The maintainer inspects the logs and authorizes recovery of unpublished state
before retrying. A published release is corrected forward; a failed final
authentication does not undo publication. Runs share one concurrency group so
different preview numbers cannot publish simultaneously. The manual procedure
below remains available for exceptional recovery and explicitly authorized
selector retirements; it carries the same authority and refusal rules.

### Prepare from public inputs

Use Node 24, dependencies from `CONTRIBUTING.md`, a clean reviewed public commit
and the next annotated preview tag at that exact HEAD.
The preceding release must be immutable with green required checks. The operation
reads public GitHub metadata, branch rules, checks and release assets. Set
`GITHUB_TOKEN` if anonymous access/rate limits are insufficient; no private repo
permission is needed. Keep credentials out of JSON, receipts and logs. Unavailable
API evidence refuses the operation.

Before you create that annotated tag, set `OPENLUP_PREVIEW` to the new preview
number and run the removal-marker check at the reviewed commit. It refuses, and
names each file, exactly as the workflow's prepare step and the producer do: a
marker naming that preview or an earlier one, or a marker line that does not
parse. It also refuses when `OPENLUP_PREVIEW` is unset or not a positive integer.

```sh
node --experimental-strip-types --input-type=module - <<'NODE'
import { assertNoOverdueRemovals } from './scripts/oss-source-release-contract.ts';
const preview = process.env.OPENLUP_PREVIEW ?? '';
if (!/^[1-9][0-9]*$/u.test(preview)) throw new Error('set OPENLUP_PREVIEW to the new preview number, not "' + preview + '"');
assertNoOverdueRemovals(Number(preview), 'HEAD');
console.log('No tracked code file is marked for removal by openlup-source-preview/' + preview + '.');
NODE
```

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

The producer applies the same removal-marker refusal as the workflow's prepare
step, so a manual cut refuses a file that is marked for removal by the new
preview even if the check above was skipped.

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
the previous release's `schemaVersion`, `platformMigrationManifest.path`,
`databaseSchema`, `policy.registryDigest`, `repository` and `release`; the
validator fixes `runtime`, and `compatibility` may change when it validates.

The producer refuses:

- an edit, deletion or mode change of an existing migration, including the
  frozen managed schema-only baseline; a change to bootstrap SQL, database
  types (`src/integrations/supabase/types.ts`) or the policy registry;
- a new migration outside the two direct migration directories, with a mode
  other than `100644`, or without a strictly increasing 14-digit version;
- a portable manifest that does not preserve its baseline and previous forward
  entries as an exact prefix, or does not bind exactly the portable files by
  SHA-256;
- non-expand-only SQL: destructive DDL (`DROP TABLE`, `SCHEMA`, `VIEW`, `TYPE`
  or `COLUMN`, and `TRUNCATE`), `RENAME`, `SET SCHEMA`, or `OWNER TO`;
- a public path at a `local-measurement` drift selector;
- a tracked code file with a removal marker naming the new preview or an
  earlier one, or with a comment line starting `// openlup-remove-before:` that
  does not parse;
- a previous receipt whose paths or drift rows differ from its own Git objects.

The approved forward path appends additive platform migrations to
`db/platform/migrations/` with the append-only portable manifest, or to
`supabase/migrations/` after `00000000000000_platform_schema_baseline.sql`.
Versions increase within each chain; the existing bytes remain immutable.
The contract's `platformMigrationManifest.digest` now describes the extended
manifest rather than equalling the preceding release's digest. Schema-5 receipt
inventory entries bind every forward's bytes and mode; the receipt schema stays 5.

The admission predicate accepts a bounded SQL subset: additive `CREATE TABLE`,
`INDEX`, `TYPE`, `SEQUENCE` or `SCHEMA`, `ALTER TABLE ... ADD`, transaction
boundaries, and literal `INSERT ... VALUES ... ON CONFLICT ... DO NOTHING` seeds.
It refuses other statements, procedural/dynamic SQL, ambiguous escapes and
unterminated comments or quotations. A new form needs its own reviewed predicate
and regression coverage. Admission checks syntax, not live database compatibility;
review constraints, defaults and replay behaviour on the selected installation.
Rows required by platform behaviour belong in idempotent forward statements.
The adopter owns extension objects and migrations in `app`; platform forwards
never write to that schema. See [Data and migrations](../docs/platform/DATA_AND_MIGRATIONS.md).

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
