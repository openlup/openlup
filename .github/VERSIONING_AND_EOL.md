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

## Preview 9 upgrade note: moved payment and communications modules

The old payment paths no longer resolve in `openlup-source-preview/9`. Import
from their new owners instead:

| Old path | New path |
| --- | --- |
| `src/domains/payment/components/PaymentForm` | `src/checkout/adapters/stripe/PaymentForm` |
| `src/domains/payment/components/RecoveryPaymentSetupForm` | `src/checkout/adapters/stripe/RecoveryPaymentSetupForm` |
| `src/domains/payment/components/StripePaymentStep` | `src/checkout/adapters/stripe/StripePaymentStep` |
| `src/domains/payment/components/useStripePromise` | `src/checkout/adapters/stripe/useStripePromise` |
| `server/domains/payment/paymentAdapterRegistry` | `server/runtime/payment/paymentAdapterRegistry` |
| `server/domains/communications/newsletterProviderRegistry` | `server/runtime/communications/newsletterProviderRegistry` |

The neutral `PaymentFormCopy`, `PaymentFormSettlement` and
`RecoveryPaymentSetupFormCopy` types live in
`src/domains/payment/paymentFormContracts.ts`.

Forks with local edits to an old path must port those edits to the new owner.
Keeping a fork's old file does not change callers that import the new path. In
particular, keeping the old Stripe loader creates a second cache. Move any
registry tests appended to the old payment registry test to
`server/runtime/payment/paymentAdapterRegistry.test.ts`. A module mock of an old
path intercepts only imports through that path; mock the new path to intercept
current callers. The newsletter provider registry had no compatibility re-export.

## Pending preview upgrade notes: catalog draft validation

Status: unreleased source change; include these notes in the preview that
first carries it. The dark catalog draft command now refuses trade identifiers
that the previous preview accepted. Correct a refused draft and send it again
under a new command key:

- A `gs1:` scheme other than `gs1:gtin` refuses with
  `trade_identifier_scheme_unsupported`. Record GTIN-8, GTIN-12, GTIN-13 and
  GTIN-14 values under `gs1:gtin`, with their digits unchanged.
- One GTIN in two spellings, such as its 13- and 14-digit forms, or with
  different issuer text, is one identity and refuses with
  `duplicate_trade_identifier`. Keep one identifier per GTIN in a draft.
- A `case` identifier without a `quantity` of at least 2, or a `unit`
  identifier with a `quantity` other than 1, refuses with
  `trade_identifier_quantity_invalid`. State how many units each case holds;
  a unit identifier may omit its quantity.

Identifiers gain the optional integer `quantity` for that purpose. Stored draft
revisions are not rewritten: a revision recorded without a quantity still reads
back, and a committed command key still replays its original receipt. The rules
apply to new create and revise commands only. Each SKU without a unit-level
`gs1:gtin` identifier now reports `unit_trade_identifier_missing` in commercial
readiness; it is advisory, and validity and readiness statuses do not change.

A product type may declare one quantity dimension with `role: "net_content"`,
whose units must all be net-content units; otherwise installing the type throws
`invalid_catalog_type_definition`. A SKU option on that dimension must state
the same quantity as the SKU's `netContent`, or the draft refuses with
`net_content_option_mismatch`; units are never converted. Types without the
role validate as before. No database schema change accompanies these notes.

## Pending preview upgrade notes: declared primary SKU and stored sellability

Status: unreleased source change; include these notes in the preview that
first carries it. It changes the row-assembled catalog read ports
(`createSupabaseCatalogReadPort` and `createPostgresCatalogReadPort`, through the
`assembleProduct` they share), the catalog pricing joins
(`joinCatalogPricing`, `joinCatalogListPricing`), and the readers built on the
catalog read port: `createLegacyCommerceQuoteCatalogReadPort` and
`createCatalogRecommendationVariantReadPort`, which
`createCatalogBackedRecommendationPort` uses. No database schema change
accompanies it.

A product's primary SKU now comes only from `catalog_products.primary_sku_id`,
never from the order in which SKU rows arrive, and each product's variants are
listed in SKU id order by both adapters; the direct Postgres adapter already
read them in that order. On the default active-only read, an active product
that has active SKU rows but whose `primary_sku_id` is null, or names none of
those rows, refuses the read with `CatalogPrimarySkuUnresolvedError` (code
`catalog_primary_sku_unresolved`, exported from `src/domains/catalog/ports.ts`).
A product with a single SKU is no exception: an empty pointer is refused, not
completed. A list read (`listProducts`, `listAllergens`) refuses as a whole and
a slug read refuses for that product; the quote, recommendation and product
compatibility routes built on the port answer the generic
`503 UPSTREAM_UNAVAILABLE`, without the product slug. A product without SKU rows
keeps the neutral placeholder, and the historical `includeArchived: true` read
keeps the declared primary or the placeholder and never refuses. The pricing
joins no longer replace a primary SKU that matches no variant, such as that
placeholder, with the first variant.

Before upgrading, list the active products the default read would refuse: every
active product that has at least one active SKU and whose `primary_sku_id` does
not name an active SKU of that product. Where such a product has exactly one
active SKU, set `primary_sku_id` to it; choose the primary of a product with
several yourself. Neither the managed chain (`supabase/migrations`) nor the
portable PostgreSQL chain (`db/platform/migrations`) backfills the pointer. Its
foreign key `(id, primary_sku_id)` references `catalog_skus (product_id, id)` and
is not deferrable, so insert a new product's SKUs first and set the pointer in
the same transaction, so that no read sees the active product without it.

The quote and recommendation readers named above now honour each SKU's stored
`sellable_standalone` and `sellable_in_subscription` flags: a quote refuses a
line in a mode its SKU is not sellable in, and a recommendation leaves such a
SKU out of that mode. The managed chain defaults both flags to `true`. The
portable chain defaults `sellable_standalone` to `true` but
`sellable_in_subscription` to `false`, so a SKU inserted there without both flags
is now sellable one-time only; set both flags explicitly. A catalog read port of
an adopter's own that returns no `sellability` on its SKUs keeps today's
behaviour, both modes. The row-assembled read ports and the static reference
adapter now set `sellability` on every variant they return, so a test that
compares such a variant with a literal by deep equality needs the field. Public
catalog responses do not change: the response schema strips `sellability`.

## Maintaining source previews

Contributors propose generic changes through public PRs and the DCO/checks in
`CONTRIBUTING.md`. Maintainers release independently of adopter deployments.
Adopters deliberately select updates and retain their private policies, branding
and supported extensions; contributing does not require publishing private history.
The release workflow publishes the immediately next preview number, from a
commit that descends from the previous preview's. An adopter may instead select
a strictly newer immutable preview from an earlier pinned release.
`gh release verify <tag>` checks GitHub's release attestation of a preview's
annotated tag. This selection rule does not turn skipped preview notes into a
general upgrade guarantee: review intervening changes and validate the selected
update's compatibility before adoption.
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
`enabled`. It runs only when dispatched from `main`. Its unprivileged package
preflight runs before the maintainer approves the `release` environment. That
approval authorizes the source preview and its checked npm package; dispatching
a run alone is not publication authorization.

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
   secrets, notes or logs. The workflow requests a repository-scoped,
   short-lived installation token and the action revokes it when the job ends.
4. Allow the App to create `openlup-source-preview/*` tags in the **tag-creation
   ruleset**. Preserve restrictions on tag updates and deletions in a separate
   ruleset without an App bypass. The workflow refuses an existing tag and
   never retags or deletes one. Main's existing required contexts remain
   `dco`, `typecheck`, `install-proof`, `test`, `self-check` and `gitleaks`.
5. Enable **release immutability** for the repository (or enforce it from the
   organization). The workflow refuses before tag creation and again before
   publication if the setting is not enabled or cannot be read.
6. Permit the workflow's pinned actions and GitHub-hosted runner under the
   repository/organization Actions policies. The job needs `contents: read`,
   `checks: read` and `attestations: read` on its default token. That token reads
   GitHub's release attestations; it cannot create a release or an attestation.
7. Finally set the **repository variable** `OPENLUP_SOURCE_RELEASE` to
   **`enabled`**. Removing it or using another value disables future runs.
   `OPENLUP_NPM_STAGE`, the `npm-stage` environment and npm trusted-publisher
   setup remain separate; follow
   [Package preview channel](#package-preview-channel) before the first cut.

In Actions, choose **Publish Source Preview → Run workflow**, select **main**,
and enter the reviewed full lowercase **target commit SHA**, immediately next
**preview number N**, and **exact release note body**. Read that body and the
target diff before approving the `release` environment. Include the adjacent
preview's upgrade actions and any applicable pending notes from this document.
If a future release policy defines a release-semantics block, include that block
in these same note bytes; this document currently defines no such block.
Confirm the package version `0.<n>.0` and its pack proof before approving a
preview that should publish packages.

The job repeats the package workflow's main-ancestry and six required-context
check at the target, and verifies GitHub's release attestation of preview N-1
with `gh release verify`. Its prepare step refuses preview N, before any tag
exists, while a code file (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.mts` or `.cts`)
anywhere in the target's tree has a removal marker naming preview N or an
earlier one, or a marker line that does not parse, and names each such file. A
removal marker is a whole `//` comment line of the form
`openlup-remove-before: openlup-source-preview/<m>`, and any comment line
starting `// openlup-remove-before:` must parse as one. Only a NUL byte in a
file's first 8000 bytes makes it binary and skips it; attributes do not.
Prepare then reads preview N-1 as an immutable published prerelease and the
commit its annotated tag names, requires the target to advance and descend from
that commit, and runs the descendant check described under
[Publish, refuse and recover](#publish-refuse-and-recover). Only then does the
job create the annotated tag with exactly `OpenLup source preview N.`

The App creates a **draft prerelease** with the exact saved note bytes and no
asset. The job records the ID returned by creation, reads only that release ID,
and checks its tag, draft identity, exact body and empty assets before publishing.
A newly created ID may briefly return 404, so this read has three bounded
attempts; any other refusal or changed draft stops the run. Publication changes
only the draft flag on that same ID. Publication makes the prerelease
immutable, and GitHub attests the release; the attestation binds the annotated
tag object. The App token emits the release event that starts
`publish-packages.yml`; the default `GITHUB_TOKEN` would suppress that
downstream workflow. The final steps check that the completed immutable release
has the created ID, exact body and no asset and that its annotated tag names the target
with the exact message, then verify GitHub's release attestation with
`gh release verify`. The separate package workflow independently checks the
release event's exact App bot user ID, the live immutable prerelease, annotated
tag and attestation before packing. Its protected OIDC job publishes the checked
tarball without another approval. A source release changes no deployment.

A failed run never automatically deletes a tag or draft or edits a published
release. An abandoned tag/draft blocks the next attempt.
The maintainer inspects the logs and authorizes recovery of unpublished state
before retrying. A published release is corrected forward; a failed final
verification does not undo publication. Runs share one concurrency group so
different preview numbers cannot publish simultaneously. The manual procedure
below remains available for exceptional recovery; it carries the same authority
and refusal rules.

### Prepare from public inputs

Use Node 24, dependencies from `CONTRIBUTING.md` and a checkout of the reviewed
public commit, fetched with `main`. The preceding release must be immutable with
green required checks. The checks read public GitHub metadata and Git objects. Set
`GITHUB_TOKEN` if anonymous access/rate limits are insufficient; no private repo
permission is needed. Keep credentials out of notes and logs. Unavailable API
evidence refuses the operation.

First verify GitHub's release attestation of the preceding preview, for example
`gh release verify openlup-source-preview/4 --repo openlup/openlup` before cutting
preview/5.

Then set `OPENLUP_PREVIEW` to the new preview number and run the removal-marker
check at the reviewed commit. It refuses, and names each file, exactly as the
workflow's prepare step does: a marker naming that preview or an earlier one, or a
marker line that does not parse. It also refuses when `OPENLUP_PREVIEW` is unset
or not a positive integer.

```sh
node --experimental-strip-types --input-type=module - <<'NODE'
import { assertNoOverdueRemovals } from './scripts/oss-source-release-contract.ts';
const preview = process.env.OPENLUP_PREVIEW ?? '';
if (!/^[1-9][0-9]*$/u.test(preview)) throw new Error('set OPENLUP_PREVIEW to the new preview number, not "' + preview + '"');
assertNoOverdueRemovals(Number(preview), 'HEAD');
console.log('No tracked code file is marked for removal by openlup-source-preview/' + preview + '.');
NODE
```

With the same `OPENLUP_PREVIEW`, run the descendant check against the preceding
preview. It reads the preceding release from GitHub and both commits as Git
objects, and refuses exactly as the workflow's prepare step does:

```sh
node --experimental-strip-types --input-type=module - <<'NODE'
import { execFileSync } from 'node:child_process';
import { assertDescendantSourceRelease } from './scripts/oss-source-release-contract.ts';
import { previousPreview } from './scripts/source-preview-release.ts';
const { OPENLUP_PREVIEW: preview = '', GITHUB_TOKEN: token } = process.env;
if (!/^[1-9][0-9]*$/u.test(preview) || Number(preview) < 2) throw new Error('set OPENLUP_PREVIEW to the new descendant preview number, not "' + preview + '"');
const previous = await previousPreview(Number(preview), token);
const target = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
execFileSync('git', ['merge-base', '--is-ancestor', previous.commit, target]);
assertDescendantSourceRelease(process.cwd(), previous.commit, target);
console.log(target + ' describes itself as a descendant of ' + previous.tag + '.');
NODE
```

Neither check writes a file or reads tracked files from the working tree, and
neither needs a tag for the new preview.

### Publish, refuse and recover

A descendant preview may add, delete or change paths, modes, package manifests,
lockfiles and other content when its release commit describes itself. The
descendant check (`assertDescendantSourceRelease` in
`scripts/oss-source-release-contract.ts`) checks that the publication catalogue
lists exactly the commit's Git inventory, that every changed direct execution
entrypoint is registered, that the policy registry's active paths exist and that
the tree's `package.json` files and their execution surfaces match the catalogue.
`config/openlup-source-release-contract.json` must equal
`deriveSourceReleaseContract` of the commit's own bytes, so every digest field
describes the tree. The contract keeps
the previous release's `schemaVersion`, `platformMigrationManifest.path`,
`databaseSchema`, `policy.registryDigest`, `repository` and `release`; the
validator fixes `runtime`, and `compatibility` may change when it validates.

The prepare step and its descendant check refuse:

- an edit, deletion or mode change of an existing migration, including the
  frozen managed schema-only baseline; a change to bootstrap SQL, database
  types (`src/integrations/supabase/types.ts`) or the policy registry;
- a new migration outside the two direct migration directories, with a mode
  other than `100644`, or without a strictly increasing 14-digit version;
- a portable manifest that does not preserve its baseline and previous forward
  entries as an exact prefix, or does not bind exactly the portable files by
  SHA-256;
- unapproved non-expand-only SQL: destructive DDL (`DROP TABLE`, `SCHEMA`, `VIEW`, `TYPE`
  or `COLUMN`, and `TRUNCATE`), `RENAME`, `SET SCHEMA`, or `OWNER TO`;
- a tracked code file with a removal marker naming the new preview or an
  earlier one, or with a comment line starting `// openlup-remove-before:` that
  does not parse.

The approved forward path appends additive platform migrations to
`db/platform/migrations/` with the append-only portable manifest, or to
`supabase/migrations/` after `00000000000000_platform_schema_baseline.sql`.
Versions increase within each chain; the existing bytes remain immutable.
The contract's `platformMigrationManifest.digest` now describes the extended
manifest rather than equalling the preceding release's digest. The annotated tag
binds every forward's bytes and mode through its commit.

The admission predicate accepts a bounded SQL subset: additive `CREATE TABLE`,
`INDEX`, `TYPE`, `SEQUENCE` or `SCHEMA`, `ALTER TABLE ... ADD`, transaction
boundaries, and literal `INSERT ... VALUES ... ON CONFLICT ... DO NOTHING` seeds.
It refuses other statements, procedural/dynamic SQL, ambiguous escapes and
unterminated comments or quotations. A new form needs its own reviewed predicate
and regression coverage. A separate
[exact reviewed function class](../docs/platform/DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards)
pins three managed forwards, exactly three existing-function replacements and
two new price-setup functions. Both required self-check and release prepare call
the same checker; replacement remains outside the expand-only predicate.
Approval must predate the feature comparison base and each release forward's
introduction commit. Exact path, whole-file bytes, old/new definition hashes and
signature cardinality must match. Admission checks syntax and pinned evidence,
not live database compatibility;
review constraints, defaults and replay behaviour on the selected installation.
Rows required by platform behaviour belong in idempotent forward statements.
The adopter owns extension objects and migrations in `app`; platform forwards
never write to that schema. See [Data and migrations](../docs/platform/DATA_AND_MIGRATIONS.md).

Earlier previews keep the rules they were produced under. Previews up to
`openlup-source-preview/7` also carry the receipt asset their workflow produced
then; later previews carry none. Do not work around a refusal; correct the tree,
or regenerate the contract as `CONTRIBUTING.md` describes.

Review the exact note and tag before obtaining publication authorization. Local
preparation does not publish or update an adopter. Publish the tag as an immutable
prerelease with the exact note body and no asset, then verify the completed release
with `gh release verify <tag>` before offering it for adoption. Publish the body
from the reviewed note file (for example `--notes-file`), never through the web
editor. To check the published bytes, compare
`gh api repos/openlup/openlup/releases/tags/<tag> | jq -j .body | shasum -a 256`
with `shasum -a 256` of that note file;
`gh release view --json body --jq .body` appends a newline and will not match.

On refusal, keep the selected version, fix the named mismatch and rerun the
checks. Discard invalid unpublished candidates. Correct published releases
forward: never add assets, retag or edit the body. Adopters retain
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
pack job refuses and that preview carries no package. Use `npm run release:bump -- <n>` in an ordinary PR to set the next version;
after this gate merges, future cuts refuse a different lockstep version and run
an unprivileged package preflight before requesting the `release` environment
approval. This tree now carries the `0.9.0` bump and has removed the files
marked for deletion by preview 9; neither the source preview nor the package
has been published by this change. The preflight checks main ancestry and
required contexts before installing without scripts,
then packs the package once and scans the exact unpacked tarball with checksum-verified
gitleaks 8.30.1. A failed scan refuses the cut before a tag exists.
The source preview still requires its existing descendant and removal-marker
checks. The package workflow publishes the tarball directly after the protected
`release` approval. It is inert until the repository variable
`OPENLUP_NPM_STAGE` is set to `enabled`.

When a source preview `openlup-source-preview/<n>` is published,
[`.github/workflows/publish-packages.yml`](workflows/publish-packages.yml) works
in two jobs:

1. **pack** accepts only a `published` event from `openlup-release[bot]`
   (GitHub user ID `334697227`). It reads the live release and refuses anything other than the same
   immutable, published prerelease with no assets. It checks the exact annotated
   tag and verifies GitHub's release attestation, then checks that the release
   commit is on `main` and that the six required GitHub Actions contexts passed
   there. It also requires the lockstep version to be `0.<n>.0`. It then runs
   `npm run packages:check -- --out packs --release-tag <tag>`, scans the unpacked
   tarballs with gitleaks, and records each tarball's sha256 and integrity.
2. **publish** runs in the `npm-stage` environment with no checkout. It verifies
   the commit, the version and those digests, then publishes each tarball with
   `npm publish ./packs/<file> --tag preview --provenance --access public`.
   GitHub's OIDC token is the npm trusted-publisher credential; there is no
   stored npm token.

Every channel version carries the `preview` dist-tag. The registry gives a new package's first
version the `latest` tag, whatever tag that publish names, and keeps a `latest`
tag on every package, so `latest` points at the first, inert version (setup
step 5) and no channel version moves it before a stable channel exists. A
tarball publish does not take its tag from `publishConfig`, so every manual
publish passes `--tag preview` explicitly, as the publish job does. A package's
`prepublishOnly` refuses `npm publish` from its directory: only a checked
tarball is published. A compromised version is deprecated and fixed forward,
never unpublished.

A release runs the workflow file of its tagged commit, so whoever can create a
preview-named tag on a commit can also change every check in that workflow. The
tag ruleset therefore restricts who may create `openlup-source-preview/*` tags,
besides updating and deleting them. The `release` environment protects the App
credential that makes those tags and events. The `npm-stage` tag rule limits
which refs may deploy to its OIDC identity; it does not replace source approval.

The maintainer sets the channel up in this order, before the variable is
enabled:

1. The `@openlup` scope belongs to the npm organization `openlup`, whose members
   are maintainers with 2FA.
2. The maintainer's npm account requires 2FA for authorization and writes
   (`npm profile enable-2fa auth-and-writes`), and holds no token that bypasses
   2FA.
3. The GitHub environment `npm-stage` exists with **no required reviewer**, no
   administrator bypass, deployments limited to `openlup-source-preview/*`
   tags, and no secrets or variables. Keep its environment name: npm binds OIDC
   to it. It must exist before the variable: a first run would otherwise create
   it without the intended tag restriction. The sole human approval remains
   the protected `release` environment.
4. The preview tag-creation ruleset permits repository administrators and the
   dedicated release App to create `openlup-source-preview/*` tags. Keep tag
   updates and deletions restricted without an App bypass, as described in the
   source release setup above.
5. A trusted publisher can be bound only to an existing package name. For each
   new name the maintainer publishes a placeholder version `0.0.0` by hand with
   2FA and `--tag preview`, outside this workflow, then deprecates it
   (`npm deprecate`).
6. Package access requires 2FA and disallows tokens
   (`npm access set mfa=publish @openlup/core`).
7. For each publishable `@openlup/*` package, replace any stage-only trusted
   publisher with one bound to `openlup/openlup`, the exact
   `publish-packages.yml` file and `npm-stage` environment, permitting direct
   `npm publish`: inspect its ID with `npm trust list @openlup/core`, revoke that
   ID with `npm trust revoke @openlup/core --id=<id>`, then run
   `npm trust github @openlup/core --file publish-packages.yml --repository openlup/openlup --environment npm-stage --allow-publish`.
   Verify the resulting scope with `npm trust list @openlup/core` before the
   next cut. npm trust changes require the maintainer's interactive 2FA.
8. Confirm the installed release App emits events as `openlup-release[bot]`
   (GitHub user ID `334697227`); the package guard pins that identity. The App
   client ID and bot user ID are different.
9. The repository variable, not an environment variable, `OPENLUP_NPM_STAGE` is
   `enabled`: the pack job reads it before any environment applies.

Before cutting a preview that carries a package, run
`npm run packages:check -- --out "$(mktemp -d)" --release-tag openlup-source-preview/<n>`
on the exact commit to be tagged: the pack job first runs after the preview is
published, when a refusal can no longer be corrected in that preview.

If GitHub publishes the immutable source release but npm fails, the source
release remains published. Inspect the package job and npm registry versions
before recovery. If no package version was published, repair the missing
prerequisite and rerun that release's failed package workflow; do not recut or
move its tag. If any package version was published, do not rerun the whole job
blindly: reconcile the partial state and correct forward with a new preview and
version. Never overwrite or unpublish a published version automatically.
