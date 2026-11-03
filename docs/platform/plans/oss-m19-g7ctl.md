# Two unbound native store signature approvals

Status: focused proof complete; staged maintainer read required. No source commit.
Code base and freshly fetched instruction/reader revision:
`4d78e855cf8bbd57704f9503cd7bae28f96453a5`.

## Outcome and boundary

Approve exactly two created-function entries in existing unbound slots:

- The purchase-reservation slot appends
  `public.inventory_admission_try_enter()` with `pg_catalog, pg_temp`.
  Its later SQL row ports a fail-fast admission gate shared by reservation,
  release, expiry and renewal stock writes.
- The renewal replay slot creates
  `public.commerce_view_shipment_destination(uuid)` with
  `pg_catalog, pg_temp`. Its later SQL row ports a nonmutating shipment
  destination view; the existing destination read pins on first read.

This change approves closed-class signatures only. It adds no behavior, SQL,
API implementation or runtime capability. Each function is ported later in
its SQL row with a characterization witness; donor citations and mechanism
mapping belong to the private feature packet. No changed path is reachable
from the reference adopter's production composition: registry and test are
repository tooling; catalog and task record are publication metadata/docs.

The complete scope is the two entries, their exact production assertions,
this compact record, its existing single sorted catalog row and required
owner explanations/navigation. Preserve all other registry bytes, including
created-function order, existing-table statements, paths, sealing and feature
bindings. The paid-notification and account-consent slots equal main exactly.
No checker/admission code, SQL, package file, manifest, lockfile or workflow
change is authorized. Package input delta must be 0 B.

The assigned worker may edit, prove, stage and replace the maintainer packet.
Stop before any source commit. The coordinator narrowed the earlier proposal
and added the purchase-reservation signature. DCO, two fresh native control
reviews, lead-selected final verification and external delivery remain separate
resumes. No merge, release, settings, secrets, provider resource or adopter
endpoint action is included.

## Acceptance and proof

Require exact equality with main plus only the two created-function entries;
assert complete created-function lists and the revised purchase count, keeping
all existing refusal and immutable-prefix assertions. Confirm the new empty-
argument signature is absent from main and accepted by the actual class reader.
Reproduce the issued renewal-claim preimage with the repository's own
`nativeStoreFunctionDefinitions(bytes, [signature], true)`. Existing replacement
pins remain unchanged. Run every existing registry-reader test, ast-grep, public
typecheck, lint, policy/docs-update and trusted main's hosted admission entrypoint.
Scan the staged diff for private names/paths. Prove package input equality.

Simplicity pre-check: append two exact entries to the existing closed lists;
no new slot, checker extension, runtime mechanism or permanent harness is needed.

## Initial evidence

Before edits, `git grep inventory_admission_try_enter origin/main` returned
exit 1 with no matches. With Node 24.21.0, command
`node .context/scratch/g7ctl-r3/signature-proof.mjs` passed: trusted main's
`readReviewedForwardRegistry` accepts the appended signature, and its
function-definition reader returns exactly the empty-argument identity.
The scratch helper source and output belong to the maintainer packet.
Command `node .context/scratch/g7ctl-r3/preimages.mjs` reproduced the issued
renewal-claim before-hash
`4814d98dbc9e6495af8d1d4d411a6a40d68cb5bcbd53aa41006bea6a34189af8`
and `pg_catalog` search path from ordered origin/main objects using the actual
repository definition reader. No replacement pin changes; the two new created
functions require absence rather than a before-hash. Final commands/output and
scratch helper sources are in the private maintainer packet.

## Documentation impact

[Closed native store forwards](../DATA_AND_MIGRATIONS.md#closed-native-store-forwards)
does not enumerate either slot's created-function list. Its generic list,
pinned-search-path, separate SQL/pin and maintainer-read rules remain correct.
No sentence claims either future function is implemented. Policy/docs-update
completed structural checks and reported only the following two no-impact
obligations. Their scoped explanations are prepared for the later authorized
commit; until then policy exits 1 with two unanswered trailers. No policy PASS
is claimed, and navigation has no generated delta.

```text
OpenLup-Doc-Impact: {"unit":"configuration","digest":"sha256-d939ca183b0796d27db3dc65ccf4d039a37d1f1148bafc5a81b2cd9d26591a4d","reason":"Only two unbound created-function entries and their pinned search paths change. No SQL, issued binding, existing-table statement, runtime capability or compatibility promise changes. Compatibility guidance still treats class inventory as control approval separate from feature SQL and installation evidence; the data owner's generic closed-list rules remain accurate."}
OpenLup-Doc-Impact: {"unit":"tooling","digest":"sha256-74923319b22291233c361fe0294308f51aa6186ced0db88ef7dff1b31d24fdea","reason":"The production created-function equality for the renewal slot is updated, and the purchase slot gains an exact ordered list with its count increased to five. The adjacent destination slot retains four, and existing refusal, immutable-prefix, test-selection and required-command assertions remain unchanged. Contributor test and verification guidance remains accurate."}
```

## Evidence history and remaining work

The initial single-entry tree passed 12 files / 2,011 tests, static checks,
package input equality and trusted-main scratch admission. The subsequent
widened candidate failed one unchanged immutable-prefix assertion (209 passed,
one failed); no assertion rerun or control repair occurred. The coordinator
withdrew that replacement and the other pending replacement. The current scope
removes the diagnosed cause without changing a cutoff, checker or assertion.
Those histories remain in private scratch packets and are not current PASS
proof. Native review has not started: zero cycles, no counted PASS or expiry.

Current candidate: all 12 files / 2,011 tests passed, zero failures or skips.
Ast-grep, five-project public typecheck (zero unresolved edges and consumer-side
errors) and lint (zero errors, 33 warnings) passed. No isolated rerun was needed.
The source branch remains at the base. Source commit, native reviews, canonical
verification, push, PR and receipt publication remain outside this stop.


## Current focused results

Node 24.21.0 / npm 11.19.0. Existing installed dependencies and package build
prerequisites were retained from the first run. Discovery was
`rg -l reviewed-platform-forwards scripts tests packages`, retaining every
existing test file. Each file ran as `npx --no -- vitest run <file>` after its
own supplied focused resource gate. The other eleven test files are unchanged.
Only the renewal created-list equality, the purchase count and its new exact
ordered-list equality differ from the base production expectations.

| Existing test file | Passed |
| --- | ---: |
| `scripts/reviewed-native-store-forward.test.ts` | 210 |
| `scripts/reviewed-batch-forward.test.ts` | 691 |
| `scripts/public-ci-neutrality.test.ts` | 60 |
| `scripts/source-preview-release.test.ts` | 718 |
| `tests/postgres/nativeStoreForwardCatalog.test.ts` | 126 |
| `tests/postgres/invoicingManagedCorrection.test.ts` | 26 |
| `tests/postgres/starterGraduationCadence.test.ts` | 14 |
| `tests/postgres/reviewedPortableCreation.test.ts` | 20 |
| `tests/postgres/subscriptionManagedStock.test.ts` | 12 |
| `tests/postgres/reviewedBatchForwards.test.ts` | 106 |
| `tests/postgres/accountSupportUpgrade.test.ts` | 2 |
| `tests/postgres/commerceManagedRail.test.ts` | 26 |

Commands `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression`,
`npm run oss:published-tree -- --typecheck` and `npm run lint` each exited 0.
The policy/docs-update command exits 1 only for the two prepared no-impact
trailers above, which cannot be counted before the authorized commit.

## Final identity and admission evidence

The final packet carries exact two-entry registry equality, confirmation that
the two withdrawn slots equal main, sorted single catalog-row equality,
package input equality (0 B), staged neutral-text and gitleaks scans,
full staged diff, staged diff SHA-256 and would-be tree. No changed file is a
package or runtime-composition input. Fresh origin/main still has both target
slots unbound and the class unsealed.

Trusted main's actual hosted entrypoint is exercised in isolated scratch Git
repositories with real local fetch, candidate capture and fork checks. Canned
GitHub reads and a synthetic two-reviewer receipt are fixture data only; they
create no actual native review, expiry or delivery grant. Its recursive imported
scripts are all materialized unchanged from origin/main. Commands:

```sh
python3 .context/scratch/g7ctl/materialize-main.py
git diff --cached | gitleaks stdin --redact --no-banner
python3 .context/scratch/g7ctl/prepare-cli-fixture.py
(
  export PATH="$PWD/.context/scratch/g7ctl/bin:/opt/homebrew/Cellar/node@24/24.21.0_1/bin:/usr/bin:/bin"
  export G7CTL_RESPONSES="$PWD/.context/scratch/g7ctl/responses.json"
  export GITHUB_EVENT_PATH="$PWD/.context/scratch/g7ctl/event.json"
  export GITHUB_EVENT_NAME=pull_request GITHUB_REPOSITORY=openlup/openlup
  cd .context/scratch/g7ctl/fixture-admission.git
  node ../trusted-main/scripts/agent-review-queue.mjs wait
)
```

Exit 0: `Native review admission verified: reviewed PR head.` The packet owns
the exact final fixture identities and output; no source commit is created.

Self-retro: the prior failed replacement was removed under the revised scope,
keeping the pre-class control and assertion intact. The existing list and
production witness suffice for both approved additions. The source-release
suite took 411.65 seconds; resource admission accounted for additional waits,
including 301 seconds before lint. No further process or scope change is needed.

## Required main integration

The precommit sections above are historical checkpoints. The maintainer later
authorized DCO sign-off, full native control review, canonical verification,
submission, receipt publication and queue delivery for the same two approvals.
After main changed the review machinery, carry-over required main integration
and fresh full review; prior reports do not count for the new candidate.

The conflict-free merge of `5054c53dc81b246b81fb77122aeb71f92cfbdd75`
into `d0d40d5249f2dd9b59a4a96180d7d25c3328f305` produced the exact
Git prediction `ac58bbf63d8a91bd5f44eaf8963f2110f66e320f`, before
this requested evidence note. The original own delta and the merged own delta
have identical added/removed-line SHA-256 hashes:

- Before integration: `0753168fafaab8ff3fd04efc524cb7b45e646d3458f1c02b22c8ab0e12564509`.
- After integration: `0753168fafaab8ff3fd04efc524cb7b45e646d3458f1c02b22c8ab0e12564509`.

The proof used `git diff 4d78e855 d0d40d52` and
`git diff --cached 5054c53d`, selected lines starting with `+` or `-`,
excluded the `+++`/`---` headers, joined the remaining lines with newlines
and included a final newline before SHA-256. Raw patch equality was overly
strict because the catalog's base blob identity changed; no source line
differed. The present note is the only additional authored delta.

The old reviewed base predates the current coverage rules. Use the native
session's full-review route and full canonical verification on the resulting
committed tree; no inherited or delta-only review is claimed. No release,
production, settings, secrets or adopter endpoint action is authorized.
Package inputs remain identical to main, 0 B.

Self-retro: raw patch metadata caused an unnecessary stop. Compare the actual
added/removed lines to distinguish unchanged task content from base identities.
