# Neutral store deployment recipes

Status: focused verification passed; source is being frozen for native review.
Local image rollback passed; no hosted qualification is claimed.

## Outcome and authority

The finite outcome is a Node/OCI recipe for an application extracted from
`examples/neutral-store`, an exercised local image-digest A → B → A rollback
with configuration-endpoint health, a tested digest comparison and strict-zero
Edge check with a planted refusal. The public-host section is a blocker list,
not a Vercel deployment recipe. Public limits may change only where merged source
proves them. System fonts remain the presentation requirement.

The assigned worker operates only in the dedicated recipes worktree and its
task notes, under the distribution supervisor. The accountable human is Bart
Roszkowski. Local implementation, disposable local proof and a DCO commit are
authorized. Canonical verification requires a later supervisor slot. Push,
upstream configuration, PR creation, comments, queueing, merge, release,
publication, credentials belonging to users, accounts, cloud resources and real
payments are outside this worker's delivery authority.

Code base and freshly fetched policy revision:
`420e68ef843092a174b84461a2bcb4882bca3c03`; initial tree:
`d0221dca1d198bad1cc0a54a8d59785af0be32a1`.

Allowed changes are deployment recipe files, this record, additive publication
catalogue rows and the requested current-limits paragraphs. Existing starter,
package, migration, workflow, publication-control logic and budget files remain
outside the implementation scope. The coordinator approved exactly one additive
execution-inventory row, with no reordering or classifier/check change:

```diff
+  "deploy/neutral-store/prove.mjs",
```

This is the sole exception, in `scripts/oss-publication-contract.ts`. The earlier
five-entry installer/host option was rejected because it would duplicate the
starter binder. No deployment-owned installer or host will be introduced. The existing public-reference OCI descriptors serve
read-only reference pages; they are unrelated to this store deployment and
will remain unchanged. The earlier distribution-evidence task is not reopened.

## Acceptance and proof plan

Build the three candidate tarballs from identified local artifacts and generate
the extracted application's lockfile before building the application image.
Never substitute registry versions or reuse the demo Compose, HBA or trust
authentication. Any later database deployment needs operator credentials through the target
platform's own secret mechanism, outside repository and image bytes. This proof
uses no database or credentials: only labelled disposable containers and loopback
publication.

Record initial image A digest, changed owned input and image B digest, health
then redeploy the exact original A digest and check health. Output and docs must
say image rollback only. No data, database, migration-history, purchase or live
store claim is included. Test comparison failures and a planted Edge
import/hook. Run unchanged affected publication, documentation and neutrality
witnesses, structural checks, lint and policy/navigation before two independent
cold reviews. No canonical verify is run until the supervisor supplies its slot.

Smallest adequate alternative: small deployment-owned scripts and configuration
using the unchanged starter image and its local configuration endpoint, with no new
platform package, deployment engine, baseline or parallel capability registry.

## Earlier scope stop

The initial scope-read checkpoint was staged tree
`45e357cca5657cdf2db4de11974849b30ef73c93`. It identified the closed execution
inventory and the starter's pending bindings/local-only host. The coordinator
approved the image-only split and the sole registration above. The five-entry
installer/host option was rejected. No review cycle was used at that stop.

## Approved continuation

The supervisor relayed the coordinator's split decision on 2026-11-02 against
staged tree `45e357cca5657cdf2db4de11974849b30ef73c93`. Its one-row execution
registration grant is recorded above. Three subcommands share one script:
`digest`, `edge` and `rollback`, with pure-logic tests. The OCI quickstart runs
only the starter's current local host. The public-host blocker list names pending
bindings, local authorities, application-owned binding/public-origin work and
operator-supplied credentials. No host config file, new bundle, account or hosted
resource is included. Data-bearing rollback and a real public-host recipe wait
for the starter's actual store bindings and are excluded from this PR.

Public text will state the current pending-bindings/local-authority boundary and
only executed image proof. Additional inventory/account limits require merged
owner checks before inclusion. No support, stability or production-readiness
claim is authorized. Canonical verify, push and upstream remain prohibited.

## Executed image proof (2026-11-02)

Pinned Node 24.21.0/npm 11.19.0 installed the unchanged root lockfile. The existing
`npm run packages:check -- --out .context/scratch/recipes/packs` built and packed
all three 0.36.0 local candidates with no findings. Package SHA-256 identities:

| Candidate | SHA-256 |
| --- | --- |
| core | `4ab15b3d7079d0819bfb4c02b392bc9c52e65793e6eee9ea618879fe23fee17d` |
| outbox | `fca9d1e7a870ae5349c5f3daebea941678d39888acd216ae08555278f86313da` |
| platform | `ceaf3eda19fea8769ff5d9262c7e3b4176982bbda82c779321f0e921a112d622` |

Source package inputs equal the base revision. These are local development
candidates, not published release identities. The starter was extracted into
`.context/scratch/recipes/prepared-app`; candidate import used those three
absolute tarball paths, validated equal versions and generated its lockfile.
Installation, packing, candidate import and the container proof used focused
admission; the proof waited 151 seconds before admission.

Executed from the worktree root:

```sh
node examples/neutral-store/extract.mjs .context/scratch/recipes/prepared-app
node .context/scratch/recipes/prepared-app/lifecycle.mjs candidate "$PWD/.context/scratch/recipes/packs/openlup-core-0.36.0.tgz" "$PWD/.context/scratch/recipes/packs/openlup-outbox-0.36.0.tgz" "$PWD/.context/scratch/recipes/packs/openlup-platform-0.36.0.tgz"
node deploy/neutral-store/prove.mjs rollback .context/scratch/recipes/prepared-app .context/scratch/recipes/proof
```

| Observation | Running image ID (local configuration digest) | Health |
| --- | --- | --- |
| A | `sha256:c0d7d986b57bbeddc699d7cb2c1592f6103f83e804233a885d45a519625f5bc0` | true |
| B | `sha256:b25416401a2c5d17c4fe227cfc6b6cb1323703ddfc79f48bfd3c3c816fc867f0` | true |
| restored A | `sha256:c0d7d986b57bbeddc699d7cb2c1592f6103f83e804233a885d45a519625f5bc0` | true |

All observations required a healthy configuration endpoint at loopback port
64685. B changed only the first English preview string in the scratch copy of
`owned/copy.ts`. The running image was read back from container inspection, not
inferred from a tag. The separate `digest` subcommand passed with those three
IDs. The final result reported `equalToOriginal: true` and explicitly:
"Image rollback only; no database, data or migration-history preservation is
proved." No Compose file, HBA, database, migration or credential was used.
Proof containers, images and scratch context were removed; read-only Docker
label queries returned zero remaining proof resources. The prepared application and generated lockfile were subsequently archived as
ignored local evidence before lint; materialized generated source copies were
removed after all consumer/publication fixtures completed. No existing starter or package source was edited.

`edge .` initially reported 43 recipe/starter files and zero findings. The final
walker includes all text inputs (also extensionless Dockerfile/lifecycle and
markup/style inputs), reporting 58 files and zero findings. A scratch
starter source containing a planted forbidden import was then scanned through
the actual `edge` subcommand; it exited 1 with `edge_check_failed` and the planted
path/rule. Pure tests cover digest syntax/equality/change, command arity, unhealthy
or reordered rollback observations, multiline imports and planted runtime/function
hooks. Test instruments and generated artifacts are outside runtime scan scope.

## Public claim decisions

Merged owner source/docs at `420e68ef843092a174b84461a2bcb4882bca3c03` were checked:
`postgresAccountSources.ts`, `postgresCustomerActorReads.ts`,
`postgresOrderHistory.ts`, `postgresAccountReadScope.ts` under account-support,
their existing account-read tests, and the platform README's native-account
section. Both public limit sections include the four native account boundaries:
explicit saved-profile/preferences/event/private-profile sources, complete consent
grant limits, historical detail without captured money, and order-owned paid
provisional activation without an invented subscription. Only existing merged
refusal codes are named. These are source-defined boundaries, not a new runtime
account qualification by this image proof.

The broader inventory-limit paragraph is left out: although the starter limits
page states it, the merged portable migration
`20261022080000_fulfillment_command_ledger.sql` contains a
`fulfillment_stock_movements` ledger and stock-movement recording routine.
A blanket "no stock movements" claim cannot be substantiated without clarifying
its scope with that owner. No new inventory claim or refusal code is added.
Pending bindings, local authorities, sandbox-only portable payments, managed-only
real money and unclaimed support/stability/production readiness remain explicit.
No private plan identifiers or adopter names are copied into public limits.

## Required unchanged-test stop

The focused driver runs one existing file per focused admission, on the pinned
toolchain, without editing existing tests. Actual results before its first red:

| Unchanged file | Result | Test execution |
| --- | --- | --- |
| `scripts/oss-published-tree-check.test.ts` | 74 passed | 7.00 seconds |
| `scripts/source-release-preparation.test.ts` | 7 passed | 6.10 seconds |
| `scripts/check-publishable-gap-enumeration.test.ts` | 5 passed | 4 ms |
| `scripts/documentation-cli.test.ts` | 3 failed | 243 ms |

The failing suite ran at 22:22:17 local time on 2026-11-02. All three failures
are `documentation: unknown path deploy/neutral-store/prove.mjs`. Its fixture
writes every closed-list execution entry, then creates synthetic routing with
no deployment-directory match. The granted new entry exposes that incomplete
fixture at `readDocumentationState` during fixture setup, before any assertion.
This is an assertion/setup failure, not a timeout; it was not rerun. The explicit
unchanged-test stop rule applies. No existing test was changed or weakened.
An owner decision is needed for a bounded fixture update or another disposition.

Remaining compatibility suites and final gated pure tests, lint, typecheck,
commit/native prepare, two cold reviews and the supervisor's verify slot remain
outstanding. The initial four pure cases passed; final scanner walker expansion
has only the actual zero-source scan so far, not a new gated pure-suite result.
The pending pure-test and second-pack waiters were cancelled before admission
when the required unchanged suite failed. A lint waiter had already been
cancelled to serialize its package prebuild with the unchanged test driver.

The initial real packs measured:

| Package | Packed bytes | Unpacked bytes | Files |
| --- | ---: | ---: | ---: |
| core | 182871 | 765428 | 229 |
| outbox | 41407 | 143183 | 42 |
| platform | 2402812 | 11311130 | 2998 |
| Total | 2627090 | 12219741 | 3269 |

Every package directory, package manifest/lockfile, build/pack tool and selected
context-owner input equals the base. None of this task's changed paths enters
npm package content or builds, so package-input delta is zero bytes/files. This
actual pack uses those identical inputs; no repeated tarball comparison is
claimed. The scratch comparison helper's first launch failed before packing on
an incorrect relative import; it was corrected, but its sole retry waiter was
cancelled at the test stop. No package source or numeric budget changed.

Policy and docs-update reached only two documentation obligations: self-host
boundary for the new proof source/tests, and contributor checks for the single
execution registration. Their pending no-impact explanations are that the local
image-only proof changes no database/runtime admission or self-host capability,
and the additive list row changes no classifier, existing command or gate.
The quickstart owns invocation and limitations. Final source-bound trailers and
passing policy still remain before review. Structural scan and both neutrality
checks passed on their recorded checkpoints; final checks must be repeated after
any approved repair. No baseline or literal environment-read increase occurred.

At that stopped checkpoint, reviewers were none and native repair cycles zero. No DCO commit,
canonical verify, push, upstream, PR, comment, queue or external deployment was
performed. Outside the original programme path list, only the explicitly granted
one-row edit in `scripts/oss-publication-contract.ts` is present.

Self-retro: required unchanged fixtures exposed a dependency missed by production
policy, which already routes deployment files correctly. Stop rather than adapt
a fixture against an explicit prohibition. Read the execution-list consumers'
synthetic owner maps alongside the real owner map when adding a new namespace.

## Authorized synthetic-owner fixture repair

The supervisor authorized a test-data-only repair in exactly
`scripts/documentation-cli.test.ts`. The prior failure was
`documentation: unknown path deploy/neutral-store/prove.mjs`; the accepted
execution row was materialized before the synthetic routing map could identify
its owner. The sole change adds deployment paths to that existing synthetic
repository owner. No assertion, expected output, setup privilege, real owner map,
control, classifier or other existing test changes. Exact diff:

```diff
-    { id: "repository", when: "Public fixture contract", paths: ["*", "scripts/**", "config/**", "packages/**", "examples/**", "src/**", "server/**", "docs/**", "db/**", "supabase/**", "tests/**"], doc: "README.md", anchor: "#contract" },
+    { id: "repository", when: "Public fixture contract", paths: ["*", "scripts/**", "config/**", "packages/**", "examples/**", "deploy/**", "src/**", "server/**", "docs/**", "db/**", "supabase/**", "tests/**"], doc: "README.md", anchor: "#contract" },
```

The existing failed attempt stays recorded above. Its rerun and remaining suites
are required before review. Any different failure cause stops this continuation
before further edits. Current fetched policy remains the original code base.
Native repair cycles remain zero; this is a pre-review fixture repair.

## Final focused evidence before the signed candidate

The authorized fixture repair passed all three cases. Every remaining selected
existing test ran without changes. Source and test inputs were held stable for
the final witnesses; only this evidence record evolved. The new Edge scanner's
literal cases were tightened before review for same-line imports, quoted runtime
keys and unquoted object hook keys. A transient match on prose was narrowed to
object-key syntax; final real-source scan is zero across 58 files and the planted
CLI import refusal remains exit 1. The final four pure tests pass. The rollback
execution path and application build inputs are unchanged by those scan refinements.

| Existing selected file | Passing cases | Existing file changed? |
| --- | ---: | --- |
| `scripts/oss-published-tree-check.test.ts` | 74 | No |
| `scripts/source-release-preparation.test.ts` | 7 | No |
| `scripts/check-publishable-gap-enumeration.test.ts` | 5 | No |
| `scripts/documentation-cli.test.ts` | 3 | Only the authorized synthetic owner string |
| [retired `documentation-bundle.test.ts`](https://github.com/openlup/openlup/blob/5acb11d04b9a0db2fc73417b24d518ac257731d8/scripts/documentation-bundle.test.ts) | 20 | No |
| `scripts/documentation-links.test.ts` | 14 | No |
| `scripts/public-ci-neutrality.test.ts` | 60 | No |
| `scripts/source-preview-release.test.ts` | 718 | No |
| `scripts/reviewed-batch-forward.test.ts` | 691 | No |
| `scripts/packages/package-release.test.ts` | 18 | No |
| `scripts/packages/set-release.test.ts` | 68 | No |
| `scripts/packages/changelog-fragments.test.ts` | 14 | No |
| `scripts/ci-test-scope.test.ts` | 58 | No |
| `scripts/generate-outcome-projection.test.ts` | 7 | No |
| `scripts/packages/eslint-import-map.test.ts` | 123 | No |
| `packages/platform/test/packageBoundary.test.ts` | 2921 | No |
| the former documentation-impact suite | 101 | No |

All 17 selected files pass, totalling 4902 cases, plus four new pure cases. No
second existing test was edited. Source-preview and batch-forward execution
together took 538.60 seconds; each file received focused admission. These are
focused results, not canonical verification. Typecheck passed all five projects
with zero unresolved edges and zero consumer-side errors. Structural scan, both
neutrality checks and staged secret scan passed at the recorded checkpoints.

The corrected scratch comparison launch completed its sole retry. It packed
all three packages again with lifecycle scripts disabled against the already
built unchanged outputs and compared full tarball bytes with the original real
packs. All three were exactly equal: zero added bytes and zero files. The
canonical class measurement reports platform code 1930553 compressed bytes,
packed 2402812 bytes, unpacked 11311130 bytes and 2998 files. Core and Outbox
measurements retain the values in the earlier table. This is local pack evidence,
not registry publication or hosted qualification.

The prepared application archive SHA-256 is
`4a887bd2b58739c6e2f1491482790d6e479f6e806c4c3f9586eb4331f7588df2`.
Its ignored archive, both tarball sets, comparison metrics and raw proof logs
remain local evidence. Materialized application/package-extraction and planted
source copies were removed before lint so generated engines are not mistaken
for repository source. No other worker's data or process was changed.

The two commit documentation-impact reasons are scoped to actual deltas:
self-host guidance still describes database/runtime admission and complete
self-host duties correctly because this opt-in proof is image-only; contributor
execution-inventory guidance remains correct after one accepted list row and its
synthetic owner fixture update, with no classifier, assertion, existing command
or required gate change. The deployment quickstart owns command invocation and
limitations. Their source fingerprints are bound by the commit trailers and
checked by final policy after the commit.

The native review candidate will use the original fork point and two fresh cold
reviewers. Actual reports and expiry belong to the local native session and
checkpoint, without post-review tracked edits. No canonical verification, push,
upstream, PR, comment or queue is authorized by this snapshot. The only paths
outside the original programme list are the two explicit narrow grants:
`scripts/oss-publication-contract.ts` (one row) and
`scripts/documentation-cli.test.ts` (one fixture string).

Self-retro: adding a source namespace needs synthetic owner coverage as well as
real-tree policy. The measured image-only split avoided a second host/installer
and kept package bytes exactly unchanged. No additional process or successor
work is introduced.

Final lint completed with zero errors and 35 warnings, all on unchanged files.
Its normal package prerequisite builds ran after the selected test driver had
finished. No suppression, rule, baseline, budget or test assertion changed.
