# Application upgrade and diagnosis tooling

Status: implementation candidate; maintainer read accepted with the bounded
registry-proof repair below. Native review and canonical verification remain pending.

## Finite outcome and authority

Deliver one `openlup` bin in `@openlup/platform` for application-file upgrade
plan/apply and the composed application's one diagnosis command. Extension-kit,
starter and deployment work belong to other workers and are excluded. No engine
behavior, SQL migration, provider execution or application activation changes.

The G15 worker operates under the distribution supervisor and programme lead.
Bart Roszkowski is the accountable human. The accepted programme delegates local
work, DCO commits, submission, receipts and merge through existing gates in the
lead's order. No publication, release dispatch, tags, hosted resources, costs,
credentials, settings or production grant exists. The stabilized API, npm bin
and publication-data changes received the designated maintainer read before DCO,
conditional on the bounded proof repair below. Two independent fresh reviewers
then assess the exact signed candidate. Canonical
verification waits for the lead to name this PR next to land; focused work uses
its own shared admission gate. No native review cycle or queue retry is consumed.

Worktree `oss-m19-g15`, branch `codex/oss-m19-g15`. Code and current policy base:
`bb0008481a11267ec6dbe3e7e531299777cddc19`, freshly recovered from `origin/main`
on 2026-11-01. Ordinary Git worktree isolation was used because no configured
helper was available. The other distribution worktrees remain untouched.

The later direct scope grant permits the bin's npm-generated lock metadata, one
package README link, and one additive bin documentation-owner row. The separate
publication-data grant permits only the matching platform scripts/bin digest and
one exact executable registration; no check logic changes. Paths outside the
original programme list are `package-lock.json`, `config/doc-routing.json`,
`scripts/oss-publication-policy.ts` and `scripts/oss-publication-contract.ts`.
Shared files contain only task-owned additions or the exact required digest and
lifecycle export-assertion update. No numeric release budget changes.

## Stabilized proposal and smallest adequate scope

Proposed bin: `openlup` → `packages/platform/src/openlup.mjs`. The tool-only source
root mirrors the existing installed-command placement pattern: it already ships
under the package's source glob and tarball allowlist, and imports the public
lifecycle entry. The lifecycle module itself cannot self-import by npm name; a
relative source JavaScript entry is not the installed compiled entry. A separate
launcher/implementation or a new tarball exception would add unnecessary surface.
One exact-file owner row routes this bin to the canonical CLI contract.

The existing lifecycle entry adds `verifyApp`, `APP_VERIFICATION_BOUNDARY` and
its report/finding types. Diagnosis delegates to the existing `checkReadiness`
using application-owned contributions, bindings and schema observer. No second
module catalogue or diagnosis command is introduced. Findings state observed
facts, cause, fix, recheck and declared/bound/checked/unknown evidence. Ports and
routes sharing a subject report their respective binding facts separately.

Upgrade delegates to the existing `planAppUpgrade` and `applyAppUpgrade`.
Snapshots supply exact UTF-8 managed bytes and compatible schema ordinals;
unlisted files remain application-owned and upstream-unchanged local edits are
preserved. Apply checks all conflicts before writing and resumes exact completed
bytes. It needs exclusive access; a whole upgrade is not atomic and concurrent
hostile filesystem mutation is outside this contract. No SQL, install, deploy,
version marker or upgrade hook runs.

Verify loads no application implicitly. Explicit `--app` trusts a module
exporting `createVerificationInput()`. It must reuse actual composition facts,
keep stdout clean, avoid host/effect startup and close its read-only observer
resources. The CLI provides no sandbox or proof of binding honesty. Only the
supplied schema observer runs; catalog presence does not prove SQL bodies,
privileges, provider delivery or a live timer. JSON format version is 1; exit
codes are 0 complete/satisfied, 1 unsatisfied/conflict, 2 unknown, 64 invalid
invocation/JSON and 74 operation/loading failure. Raw application errors are
withheld; operation failure can follow a partial file upgrade.

## Acceptance and sufficient executed evidence

| Boundary | Discriminating proof and result |
| --- | --- |
| Report correctness | Package-local diagnosis file: 3 cases PASS, including colliding port/route names, declaration-only bindings, unavailable and wrong-database observations, repair to ready and no route/job execution |
| Installed CLI | Actual npm-created executable in a disposable consumer; help, invalid input, missing app, unknown, text/JSON findings, exact repair keys and recheck commands PASS |
| Real-version upgrade | Integrity-pinned published platform/core pairs 0.35.0 and 0.36.0; the app executes each platform's public lifecycle entry with coherent peer pins. Divergent later-sorted file refuses before every write; actual SIGKILL after the first rename, exact resume, startup refusal of partial state and local theme/policy preservation PASS |
| Real schema diagnosis | Existing core schema probe over an owned PostgreSQL 17 fixture in a read-only transaction: stale migration identity, missing table, binder and schedule detected. Applying the report-named fixture migration and fixing bindings reaches ready; PASS |
| Artifact identity | Working-tree pack content matches materialized package source/derived-file rules; no findings. This is preliminary evidence, not final committed-candidate install proof |

These assertions are wired into the existing required platform cold-consumer
path and invoke no model. The fixture harness prepares archives, dependencies
and database repairs; the CLI never performs those setup actions. Published
archive unavailability or integrity mismatch fails the proof, with no synthetic
or workspace substitute. This is file/entrypoint proof, not a complete store,
database-version upgrade, provider certification or independent-adopter result.

## Checks, measurements and remaining gates

Pinned Node 24.21.0/npm 11.19.0 asserted. `npm ci` passed. Final `npm run lint`
(including all three prerequisite builds) passed with zero errors and 33 existing
warnings. Structural scan passed. Public typecheck passed all five projects with
zero unresolved edges and zero consumer errors. Generated lifecycle API snapshot
and API check passed; no other package API report changed.

Real platform working pack: 2,112,932 packed bytes, 9,837,031 unpacked bytes,
2,844 files. Against integrity-verified published 0.36.0 (2,104,577 packed bytes,
9,809,502 unpacked bytes, 2,840 files): +8,355 packed bytes, +27,529 unpacked bytes,
+4 files. Existing code/docs/total size and file caps all pass. No cap raise.

The maintainer accepted the read candidate tree
`8669a23104f35015869305785d91a839f9353004`, with only the registry reliability
repair required before sign-off. The post-repair source snapshot, before updating
this task-record evidence, is tree
`e0b72951382dbf56e86dd334b3e6abb90fed99f5`. It includes the original task-record
blob; it is not a self-reference to this record's final tree. Relative to the
accepted snapshot, only `scripts/packages/distribution-cli-proof.ts` and this
evidence record change. The final committed head/tree belong in the checkpoint.

The proof now makes at most two attempts per immutable archive, each with a
60-second fetch/body deadline and a 195-second enclosing process limit. The one
retry honors seconds or HTTP-date `Retry-After`; its wait is bounded at 60 seconds.
A longer requested wait refuses with an explicit budget error rather than
retrying early. Without a valid header, the retry delay is one second. HTTP 429,
402/403 and 503 with a retry header produce a named quota error distinct from
unavailable. No mirror or synthetic substitute. Load-sensitive CLI, archive
extraction, application startup and SQL-harness children now allow 60 seconds;
existing outer verification budgets and release caps are unchanged.

Post-repair scratch regression: 11 deterministic cases of the exact emitted
fetch code pass, including network/body failure, numeric/date Retry-After,
quota versus unavailable, two-attempt bound and excessive retry-delay refusal.
The installed real-version CLI and actual PostgreSQL proof pass again. The
three package diagnosis cases pass again. The code under `packages/platform`
is byte-identical to the accepted tree, so the measured shipped-byte delta
above is unchanged; the repair and task record are outside the tarball.

Policy/navigation was regenerated on the would-be committed set. Ownership,
repository and tooling obligations use exact delta-bound no-impact commit
trailers: the additive owner route follows existing rules; the lockfile only
records the bin; required contribution commands, outer budgets and publication
check logic remain unchanged. Canonical CLI guidance and the package link explain
the new surface. The tooling digest was recomputed after the proof repair. The
signed change must actually pass policy before native review; an unrecorded
trailer is not a PASS.

PR-body text prepared for later authorized submission:

> The real-version proof depends on registry.npmjs.org for SHA-512-pinned
> @openlup/platform and @openlup/core archives at 0.35.0 and 0.36.0 (about 2 MB
> per platform archive plus the smaller core peers). Each download permits two
> 60-second attempts, honors Retry-After with a bounded wait and names quota
> failures. Two red runs caused by HTTP 429 or a registry outage mean the proof
> moves to a cache the same day.

This record is frozen before native review. No native PASS, receipt, push, PR
or canonical verification exists at preparation. After sign-off and actual
policy PASS: obtain two fresh reviews, then request the lead's verify turn.
Canonical verify, push and PR creation remain held for that explicit instruction.
Do not extend work into the separately assigned distribution rows.

Initial drafting lacked installed structural tooling and exposed missing bin
ownership/publication registration. The first lint found the misplaced launcher
and an embedded fixture boundary; both were repaired. The first focused unit
run found port/route-name ambiguity; its regression now passes and the installed
consumer also covers that class. These are pre-review repairs, not native cycles.
One earlier focused admission timed out after 542 seconds and was repeated as
instructed; the post-read rerun was admitted after 393 seconds. All heavy work
waited for actual admission. No authority or budget was reset.

Self-retro: reuse the package-root tool seam instead of weakening module rules;
report binding facts instead of inferring a kind from a shared subject. The
current authority register already settled publication-data scope and should be
read before repeating that coordination question. Bounded retries and realistic
child deadlines address registry/load noise without replacing immutable inputs
or weakening refusal. No separate process change.
