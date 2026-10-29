# Supabase CLI pin update

Status: local fix round 2 implementation and required proof complete after two
independent re-review FAIL reports; uncommitted handoff to Claude; development preview.

Outcome: one Supabase CLI 2.122.0 pin across active CI, disposable SQL runners,
tests and current contributor instructions, with exact image tags and verified
digests. The GitHub releases API reported v2.122.0 as latest stable, not a
prerelease, on 2026-10-29. Historical run evidence keeps its original versions.

Authority: Bart Roszkowski requested local edits and proof in
`claude/supabase-cli-bump`. Code base remains
`6e7adb51e742a132b879a94ef07e5cfed60f694c`; the separately fetched policy
revision at fix-round start and handoff is
`eb1a0584f035774251a8c296e82f3b9ffd68180b`. Applicable contribution/agent/AI
instructions have no delta since the earlier pin. Codex implements
and verifies; Claude owns any subsequent Git/PR work. No commit, push, PR,
counted review tooling, workflow dispatch, hosted Supabase operation, staging,
production, Homebrew change or release is authorized. No review session was
created or consumed. The branch was not rebased or merged.
Independent committed review remains a later delivery gate.

Scope: active pins, image inventory/derivation and refusal witnesses as required
by the CLI's actual image selection, and owning documentation. Excluded: SQL,
application behavior, historical plans/evidence, unrelated image versions and
shared machine resources. This compact record supplies both intent and plan
under CONTRIBUTING.md's contribution-shape rule; no new specification is needed.

Acceptance and proof plan: confirm release API asset identities and SHA-256 by
downloading the macOS arm64 and Linux amd64 archives plus checksums; inspect the
tagged source, rendered config and CLI services; inspect registry manifests;
update the smallest existing pin/reader seam; run documentation policy and
structural checks, whole affected script test files, lint/typecheck and the raw
pgTAP runner with the temporary CLI and Node 24.21.0. Heavy commands run serially
through ai-resource-gate with a 3600-second queue timeout. Report actual exits,
mirror prerequisites and any unexecuted proof without claiming hosted readiness.

Risk and simplicity pre-check: the newer CLI changes service images and its
implementation, so a version replacement alone cannot establish compatibility.
Reuse the existing image inventory, derivation, pull and mirror helpers; preserve
migration byte checks, exact local image checks, resource budgets and owned
cleanup. Preserve origin/main public upstream fallbacks and the install-proof
service reference. Mirror publication is an owner action outside this task.

## Release, image and configuration evidence

[Latest stable release API](https://api.github.com/repos/supabase/cli/releases/latest)
returned release `421737738`, `prerelease=false`, tag `v2.122.0`. The annotated
tag resolves to source commit `5afad870388552d0198087d27037da7ac745ba2b`.
Downloaded assets were hashed locally and matched both API metadata digests
and the downloaded checksums file:

| Asset | API asset ID | SHA-256 |
| --- | --- | --- |
| `supabase_darwin_arm64.tar.gz` | 668849778 | fe87a5f9781d5423dbd5ebba2d5a6e1a541d01754d14941c574952e5695eaab0 |
| `supabase_linux_amd64.tar.gz` | 668850237 | 59ed066847b98d7461c60e9109d40cab6b9756177ce06ebb05b51338519f5136 |
| `checksums.txt` | 668849747 | 797e8703c0cd8bc7a268d21f4cd995129c2b24da5a2f59dff1e6b5b069732537 |

The same versioned archive aliases have API IDs 668847168 (macOS arm64) and
668847644 (Linux amd64) and identical digests. Existing setup-cli installation
needs only the version pin; there is no tracked CLI checksum installer to update.
The temporary install is `/private/tmp/openlup-supabase-2.122.0/bin`; Homebrew
was not changed. Node 24.21.0/npm 11.19.0 come from the existing versioned Node
installation. CLI state is isolated with `SUPABASE_HOME` and telemetry disabled.
An initial sandboxed CLI probe failed writing default-home telemetry state;
pointing its documented state directory at temporary storage resolved that.

The downloaded tagged Dockerfile and `supabase services` on the rendered
unchanged reference TOML select the following pgTAP/bootstrap images. GHCR and
ECR raw manifest bytes independently hash to identical multi-platform digests;
`config/ci-images.json` records all five exact digests.

| Repository | Previous CLI tag | CLI 2.122.0 tag | Index SHA-256 |
| --- | --- | --- | --- |
| supabase/postgres | 17.6.1.106 | 17.11.0.006 | c141fd17ac6a76c4323e90b3aee8ff1a23d2e89e547c2b963cfadc309c079cc2 |
| supabase/gotrue | v2.188.1 | v2.197.0 | 1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b |
| supabase/realtime | v2.86.3 | v2.147.1 | b7b0ef84b69d80b9b9c2280c9e9ae0a901175d3035b6b0c3ae22fa6c48bfb272 |
| supabase/storage-api | v1.54.1 | v1.84.19 | a0420573837ee08c0afdc9cd01f90b4b8027579da99e0b9a159fe912ef756c99 |
| supabase/pg_prove | 3.36 | 3.36 | eda7c5e68719e9c8287e78c017118407b48df904a51c935f5ab6098b8c0bc6bc |

Other default-stack tags change as follows; the pgTAP exclusion list excludes
them, so they need no pgTAP mirror pins: PostgREST v14.10 → v16.5;
postgres-meta v0.96.4 → v0.100.0; Studio 2026.04.28-sha-89d08a2 →
2026.10.19-sha-b375769; edge-runtime v1.73.13 → v1.77.8; Logflare
1.39.1 → 1.50.15; Supavisor 2.7.4 → 2.9.13; Mailpit v1.22.3 → v1.31.3;
imgproxy v3.8.0 → v3.26.0; Vector 0.53.0-alpine → 0.58.0-alpine;
Kong stays 2.8.1. The tagged CLI also has PG15/PG14 alternatives, but the supplied
configuration selects major 17. No TOML change was required by `services`.

The CLI's Compose backend defaults to ECR, then GHCR/Docker Hub without an
explicit override. The setup action supplies GHCR; our runner explicitly passes
its first successful registry, validates digest-qualified local images, then creates
plain-tag local aliases so the CLI needs no pull. The CLI's newer stack/slim
backend is not selected by this rendered TOML profile.

Fix-round scope reconciliation: the coordinator requires the CLI version bump to
preserve public/fork CI without private packages. Restored origin/main's shared
non-CLI upstream fallbacks and Docker Hub install-proof service reference,
including its existing digest and permissions. The platform cold consumer's
strict comparison now matches again; its identity/container/port checks need no
change. CLI pin binding returns upstream-only sources for mirror writers;
pgTAP alone prepends the organization mirror for runtime acquisition. CLI
upstream GHCR images already have the recorded digests, so no organization
mirror publication is needed. Hosted CI and mirror visibility remain unverified.

Added the authored publication-catalogue row for this active task. Policy and
navigation will be checked with this previously untracked plan included using a
disposable validation checkout; the task worktree's real Git index is untouched.
A new CI=true offline witness proves cold fallback after mirror HTTP 401 for all
three non-CLI pins, and writer tests prove no organization mirror is selected as
a copy source. No counted native review is invoked; Claude owns subsequent
commits and fresh review. The two supplied FAIL reports establish open findings,
not native-session admission or repair-budget state.


## Previous local proof and handoff (before fix round)

All heavy commands ran serially under `ai-resource-gate run --wait
--queue-timeout 3600 <resource> --`, using the temporary CLI and Node 24.21.0 /
npm 11.19.0. Logs and command/exit details are retained in
`/private/tmp/openlup-supabase-2.122.0/`:

- `npm ci --prefer-offline --no-audit --fund=false`: exit 0.
- `npm test -- scripts/ci-image-mirror.test.ts scripts/ci-image-pull.test.ts
  scripts/oss-published-tree-check.test.ts`: initial exit 1 (245 passed, two
  stale assertions concerning added package permission and measured retries);
  corrected full-file rerun exit 0, 247 passed. Final strict-pin implementation
  also passed all 247 with `CI=true`, exit 0 (33 seconds including tests;
  package prebuilds are additional). CI and local source-selection cases are
  explicit, so local fallback fixtures do not inherit hosted restrictions.
- `npm run lint`: exit 0, 33 existing warnings; 135 seconds including broker
  wait. No warning fixes or rule changes are included.
- `npm run oss:published-tree -- --typecheck`: exit 0; all five configured
  projects, zero unresolved edges and zero consumer-side errors; 22 seconds.
- `node scripts/public-ci-pgtap.mjs`: exit 0; all shipped SQL tests passed with
  CLI 2.122.0: 226 files / 5,199 assertions, baseline/forward replay and owned
  stack cleanup; 40 seconds.
  The existing denial-hint workaround still applied successfully.
- `npx --no -- ast-grep scan --error=no-suppress-all
  --error=unused-suppression`, agent-context generation/freshness,
  `npm run oss:published-tree -- --policy --docs-update` and `git diff --check`:
  exit 0. Policy reported five documentation obligations, zero unanswered.
- CLI `--version`, `services`, mirror `plan`, exact inventory binding,
  archive/API/checksum comparison and GHCR/ECR manifest hashing: exit 0.
  Organization package checks remain the 401/403 access limitation above.

No runtime incompatibility was observed in this local profile. Full identity
acceptance/conformance commands and hosted CI were not run; changing their
version checks is not proof of those entire flows. Historical plan/evidence
records remain unchanged. The final requested summary is written outside the
repository at the owner's supplied scratch path. No commit, submission,
counted review, workflow dispatch or hosted Supabase action was performed.

Self-retro: the first complete affected test run caught two stale expectations;
checking the added permission count and observed retry behavior together would
avoid that rerun. Explicitly testing `CI=true` caught the need to keep local
fallback fixtures independent of hosted source selection. Reusing the existing
inventory and pull loop kept digest binding small. The largest delay was broker
queueing behind other sessions; leaving their resources alone preserved the
shared-machine budget. No process optimization or successor task is introduced.

## Fix-round proof

All requested reruns passed on the repaired source. Logs are retained beside
previous logs under `/private/tmp/openlup-supabase-2.122.0/`, with `fix-` prefixes.
The source was frozen across serial heavy phases; only this execution record was
updated afterwards. Every heavy phase used `ai-resource-gate run --wait
--queue-timeout 3600 <resource> --`, with explicit CPU/memory reservations for
the whole suite and final lint/typecheck/pgTAP phases.

- Latest stable API still reports v2.122.0, not a prerelease. Fresh macOS arm64,
  Linux amd64 and checksum downloads match API digests; the checksum file lists
  versioned aliases with identical archive hashes. The temporary binary matches
  the fresh archive byte-for-byte. Host CLI remains 2.120.0. Exit 0.
- Affected complete Vitest files with `CI=true`: exit 0, 247 tests passed.
- Entire `CI=true VITEST_MAX_WORKERS=4 npm test`: exit 0, 2,176 files passed,
  one file skipped; 22,508 tests passed, four skipped; 512 seconds.
- `npm run lint`: exit 0, zero errors and 33 warnings, 28 seconds.
- `npm run oss:published-tree -- --typecheck`: exit 0, five projects, zero
  unresolved edges and zero consumer-side errors, 24 seconds.
- `node scripts/public-ci-pgtap.mjs`: exit 0 with temporary CLI 2.122.0;
  226 SQL files / 5,199 assertions passed, replay and owned-stack cleanup;
  48 seconds including 15 seconds of broker wait. Every image resolved from
  upstream GHCR at the exact inventory digest, without organization access.
- Policy/navigation regeneration with this plan included: exit 0, five
  obligations and zero unanswered. Generated navigation had no byte delta.
  The final policy and inventory check use the disposable validation checkout,
  which includes the plan without staging anything in the actual task index.
- Structural scan, context generation/freshness and `git diff --check`: exit 0.
- Anonymous registry token/manifest reads and independent raw-manifest hashing
  verified both library PostgreSQL pins from Docker Hub and all five CLI pins
  from upstream GHCR. Empty-local-state offline tests prove mirror HTTP 401
  falls through to upstream in CI. Copy-source tests prove upstream-only writer
  resolution. No shared Docker image/cache was removed to manufacture a cold run.
- The actual workflow service string equals the cold consumer's imported
  `POSTGRES_PROOF_IMAGE`; its strict image/container/port checks stay unchanged.

Failed attempts retained: initial affected tests exited 1 because sandboxed
loopback probes returned EPERM; the permitted rerun passed. Initial policy
exited 1 for the new row's sort position, then passed after correction. An
initial checksum-filename assertion exited 1 because it used unversioned names;
API hashes had matched, and the corrected versioned-alias comparison passed.
Anonymous manifest inspection hit HTTP 429 after five successful pins; a bounded
follow-up verified the remaining two. The first full-suite wrapper was stopped
with exit 143 after noticing CI's unrestricted worker default; only its exact
owned PID was signalled, and the explicit four-worker rerun passed. No unrelated
process, lock, container or volume was killed, released or cleaned.

The supplied major service-identity, publication-inventory and private-mirror
findings are addressed; writer-source and fallback prose now match execution.
This is implementation/proof evidence, not a fresh committed review receipt.
Claude still owns the commit, independent review and any separately authorized
submission. Hosted CI, full identity acceptance/conformance and fresh cold-layer
network transfer were not executed; no hosted Supabase action or owner decision
was needed. No release, workflow dispatch, package publication or visibility
change was performed.

Fix-round self-retro: unnecessary source restriction caused the private-package
regression and the service identity mismatch. Restoring existing acquisition
behavior fixes both without broadening the consumer's trust boundary. Catalogue
checks must include new authored files; checking only the tracked inventory hid
the missing row in the earlier run.


## Fix round 2: preserve registry recovery

The two supplied re-review FAIL reports identify one major regression: a
GHCR-only pin guard and source override removed working ECR/Docker Hub recovery.
The approved repair preserves origin/main acquisition semantics and adds only
reviewed digest binding. No new authority, native session or retry budget is
inferred from the reports. Claude retains commit and subsequent review ownership.
The freshly fetched instruction revision remains
`eb1a0584f035774251a8c296e82f3b9ffd68180b`, separately from the code base above.

Removed the GHCR-only guard. Mirror planning still constructs ECR then Docker
Hub sources itself; pin binding preserves that order and verifies the inventory
digest. The pgTAP pre-pull source list is byte-identical to origin/main:
organization mirror, upstream GHCR, ECR, Docker Hub. Each pull and local reuse
still verifies the exact reviewed index digest. Existing aliases, inspection,
retry budgets, aggregate deadline and owned cleanup remain unchanged.

Restored both shipped-runner lifecycle tests requiring successful ECR recovery
from GHCR 429s and Docker Hub recovery from GHCR 429s plus ECR 503s. Acquisition
assertions now include the digest, and exact CLI aliases remain plain tags.
Lower-level witnesses also require both successful fallbacks with supplied pins.
Current contributor, canonical-contract and documentation owners describe these
paths. Prior round proof above records that candidate only; it does not establish
passing proof or review for this repair.

Release API reconfirmed latest stable v2.122.0 (not prerelease/draft), release
421737738. Fresh downloads of both archives and checksums match the API asset IDs
and SHA-256 values in the release table above. Versioned checksum aliases also
match, and the temporary macOS binary equals the fresh archive member. Logs and
fresh assets use `fix2-` prefixes under `/private/tmp/openlup-supabase-2.122.0/`.

Requested proof: complete affected Vitest files, whole Vitest with `CI=true
VITEST_MAX_WORKERS=4`, lint/typecheck, policy/docs with this plan included, and
raw pgTAP through the temporary CLI 2.122.0. Heavy commands run serially through
the resource gate. Initial affected run exited 1: 245 passed, three stale
assertions (writer source, removed outage refusal, and local-inspection count)
were exposed by restoring fallback. These assertions were repaired before rerun.


### Fix round 2 completion evidence

All requested checks passed. Heavy phases ran serially under
`ai-resource-gate run --wait --queue-timeout 3600`, with four CPU tokens / 8192 MB
for whole Vitest and two / 4096 MB for the other phases. The temporary CLI and
Node 24.21.0 environment is recorded in `verify-env.sh`. The frozen-input hash
was unchanged across whole Vitest, lint, typecheck and pgTAP; only this execution
record was updated after those phases.

- Affected complete files (`CI=true VITEST_MAX_WORKERS=4 npm test --
  scripts/ci-image-mirror.test.ts scripts/ci-image-pull.test.ts
  scripts/oss-published-tree-check.test.ts`): exit 0, 249 tests passed;
  `fix2-affected-vitest-final.log`, 42 seconds in Vitest.
- Entire `CI=true VITEST_MAX_WORKERS=4 npm test`: exit 0, 2176 files passed,
  one skipped; 22510 tests passed, four skipped; `fix2-full-vitest.log`,
  473 seconds including prebuilds and one second of broker wait.
- `npm run lint`: exit 0, zero errors / 33 existing warnings;
  `fix2-lint.log`, 29 seconds.
- `npm run oss:published-tree -- --typecheck`: exit 0, five projects,
  zero unresolved edges and zero consumer-side errors;
  `fix2-typecheck.log`, 25 seconds.
- `node scripts/public-ci-pgtap.mjs`: exit 0 with temporary CLI 2.122.0,
  all 226 SQL files / 5199 assertions passed, transactional replay and owned
  cleanup successful; `fix2-pgtap.log`, 71 seconds including 41 seconds waiting
  for the shared resource lane. The unchanged rendered TOML started successfully.
  All five images reused verified GHCR digest references in this run; forced
  GHCR/ECR outages and successful fallback are proved by the offline witnesses.
- Policy/docs regeneration and subsequent check with this authored plan tracked
  in a disposable validation index: exit 0, five documentation obligations,
  none unanswered; `fix2-policy.log`. No generated navigation byte delta.
  Final policy rerun includes this completion record. An extra bare
  `npm run oss:published-tree` invocation exited 2 (required mode missing);
  the corrected `--inventory` command exited 0 with all 6623 paths, including
  this plan. Logs: `fix2-final-policy.log` and `fix2-inventory.log`.
  A direct policy run against the actual unstaged index exited 1 because that
  index intentionally omits the new plan; the final handoff check uses the
  disposable validation index with the plan included. The task's actual index
  remains untouched, and no commit was created. Claude must include the plan
  with its catalogue row when preparing the commit.
- Structural scan, agent-context generation/freshness, CLI mirror `plan`, CLI
  version probes and `git diff --check`: exit 0. Temporary CLI is 2.122.0;
  `/opt/homebrew/bin/supabase` remains 2.120.0.
- Fresh anonymous raw-manifest SHA-256 independently matches every CLI pin on
  ECR, Docker Hub and GHCR (15 successful comparisons). The initial GHCR token
  request incorrectly included a trailing slash and returned 404; the corrected
  endpoint completed all five GHCR comparisons. Both attempts are retained in
  `fix2-manifests.log` and `fix2-ghcr.log`; raw manifests and results are in
  `fix2-manifests/`. No product fallback was removed because of registry errors.

The supplied finding is repaired, with fresh local proof. This is not an
independent committed review or a native review receipt. Claude owns subsequent
commit/re-review and any separately authorized submission. Hosted CI, the full
identity acceptance/conformance flows and cold image-layer network transfer
remain unverified; no hosted Supabase, staging or production operation ran.
No owner decision, mirror publication or settings change is needed for this
repair. Historical records and unrelated resources remain unchanged.

Fix round 2 self-retro: the first affected run exposed three stale assertions;
restoring the main lifecycle cases before broad testing caught all three at
low cost. The earlier GHCR restriction was unnecessary: preserve acquisition
semantics first, then add digest verification without changing recovery.
The only shared-machine delay was the measured 41-second pgTAP lane wait.
No process change or successor work is introduced.
