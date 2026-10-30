# M14 hosted S3 recipe receipt

Status: development-preview implementation and hosted functional proof complete; maintainer reads accepted, native review and lifecycle observation pending. No delivery-qualified PASS is claimed.

## Outcome and authority

Produce the hosted S3 recipe receipt (single synthetic bucket, one region) through the existing recipe runner and object witnesses. This is parcel 10O; it does not qualify production, an SLO, other providers, or the whole M14 programme.

The active supervisor is the single writer in the assigned `codex/oss-m14-s3-receipt` worktree. Authorized actions are local implementation and checks, synthetic objects on the declared hosted bucket through the VM instance role, and eventual DCO submission and merge after the applicable maintainer read, two fresh FULL reviews, canonical verification and live delivery gates. Release, IAM, account settings, resource deletion, other buckets and production are excluded. Public listeners are excluded. The current delivery freeze prevents ready/queue actions.

## Scope, acceptance and proof

Reuse the existing S3 blob port and 8B source/copy boundary, preserving the 9A rule that later erasure obligations constrain an older snapshot before publication. Declare only a hosted S3 runner target, with no dependency, provider registry or new recovery engine. Prove normal-path upload/read/delete, authorized serving and anonymous/cross-user refusal, size/content refusal, native versions and delete markers, and source admission that requires exactly one current version per key and no delete markers. Prove restore of retained objects without publishing erased data. Declare any application authorization boundary separately from instance-role bucket authority.

Read lifecycle configuration at run start, create dedicated noncurrent objects early, record UTC clock start and retain only those observation objects across resumes. Report lifecycle PENDING-OBSERVATION until actual version absence is observed after the required elapsed interval. Final cleanup removes every version and delete marker under the unique run prefix and reads back zero of each. Record wall time, actions, interventions, fixture size and explicit limits.

Proof order: publication inventory/policy, structural scan, focused admission/refusal witnesses, redacted secret scan, strict all-project typecheck and load-gated lint; hosted run and lifecycle clock; stabilized control/API read before DCO; two independent fresh FULL reviews and load-gated canonical verify. A read packet ends the run when required. No review or verification substitutes for elapsed lifecycle observation. Observe around T+26h and T+50h, then update under the applicable read or narrow evidence correction route.

## Initial evidence and risk

Code base: `4fd84bfead64e11f76e0555117fe072d39807182`. Current instruction-policy pin: `4fd84bfead64e11f76e0555117fe072d39807182`, separate from review base. Initial tracked inventory: 6,699 files / 50,703,630 bytes. No package file or export is planned, so package publication caps are unchanged; the publication catalogue must include each new tracked file before the read.

The runner currently admits database targets only; the local witness creates extra buckets and accounts, which this grant excludes. Hosted selection therefore needs a bounded declaration and prefix-scoped composition of existing ports. Current 8B capture refuses native version IDs. Its hosted admission extension must independently enumerate history with bounded pagination and compare history around capture under host-held writer exclusion. Filtered or incomplete history must refuse; lifecycle rule acknowledgement is not observed expiry.

## Hosted clock and execution

Lifecycle baseline rule readback and seed creation completed on 2026-10-30. Clock start: `2026-10-30T08:15:03.124080Z`. Two dedicated keys retain three noncurrent versions. Observation checks: `2026-10-31T10:15:03Z` and, if still pending, `2026-11-01T10:15:03Z`. Exact identities and continuity state remain private on the worker. These objects were created early through the worker CLI; the runner must independently admit and observe their exact version state before counting lifecycle evidence. No elapsed-expiry PASS is claimed.

Pinned `npm ci` completed. Initial policy/catalogue/documentation checks passed with zero unanswered obligations. A seed command using a non-regular empty-body path refused locally before any S3 write; a regular test-owned empty file resolved that CLI input issue and was removed. This was one provisioning intervention, not a lifecycle retry.


## Stabilized proof and remaining work

CD-M14-53 maintainer read accepted the candidate under the required declared-region repair. The coordinator recomputed equal identities: HEAD `4fd84bfe`, tree `0d217f16c1cd355101692191efc5383bc18f2c55`, and SHA-256 of `git diff --binary HEAD 0d217f16` `5bab2cc9d251a5018e098bdcdafb34575992cb1fd2c09baf4e87147d5786adca`. The region repair removes the fixed-region admission, requires AWS region syntax, uses synthetic test data, and describes a declared region in public instructions. DCO and review were pending the delta read at this point.

After this repair, publication policy/catalogue/impact (2 obligations, 0 unanswered), inventory, structural scan, neutrality, redacted secret scan, strict all-project typecheck, lint (0 errors, 33 existing warnings) and the focused S3 declaration/refusal test passed. The staged delta required its own maintainer read before DCO.

CD-M14-55 accepted that region-only re-read. The coordinator recomputed equal identities: repaired tree `2a35b0e4af811831d697ebb9ee79c4c90f6ba5db` and SHA-256 `c587113375513c17399d58c96a50789b89ab36033d924db470f330432e922a8b` for `git diff --binary 0d217f16 2a35b0e4`. Signed commit `950ad6498a7da85f48256e4173e1bf3c0b3ab13e` has exactly that tree. This record note adds no claim or control change.

The hosted run on `2026-10-30T08:40:50.523Z`–`2026-10-30T08:40:55.846Z` passed serving, authorization/anonymous/cross-user refusal through the real customer BFF with synthetic host grants, actual anonymous bucket denial, bounded-byte and source-record content-type conflict refusal, native-version/deletion and single-current admission refusals. The retained older-snapshot object resumed after checkpoint interruption and served correctly; the later-erased key remained absent from the private destination. This is not IAM cross-account, hosted database/RLS, generic upload-policy or whole-store hosted RPO/RTO qualification. The adapter owner records these limits.

Tested WIP: `6a214b718b9503e4151541cd30fa81625d33fdf4`; tree `dbc10be0a3f16a63c2a9f154f331d12138f17d70`; source SHA-256 `1c3cf3e673e17727b6a752d06594015a5f9278d8c20126e594a368260917cc97`. Pinned Node 24.21.0/npm 11.19.0 ran workspace `0.32.0` builds from the archive. The final task-record evidence note changes only prose after that source proof. No package API, manifest, lockfile, dependency, SQL, provider registry or budget changed.

Checks: policy/catalogue/inventory, documentation regeneration/impact (2 obligations, 0 unanswered), structural scan, neutrality (0 increases), redacted secret scan, strict all-five-project typecheck and full lint passed; lint reported 0 errors and 33 existing warnings. Focused source/declaration/lifecycle proof passed 46 tests in 5.79 seconds. The unchanged PostgreSQL fresh-catalogue test was deliberately not selected on the shared worker; it remains part of the later Mac canonical gate. No coverage or canonical verification PASS is claimed.

The final witness took 2.624 seconds (runner 5.323 seconds), with 42 direct SDK actions and 9 blob-port actions, no witness retry or run-time intervention. Provisioning, dependency installation and lifecycle wait are excluded. The direct client has maxAttempts=1; the blob client retains the SDK default retry policy. The baseline readback was enabled, with noncurrent expiration 1 day and incomplete multipart abort 1 day; no rule was changed. Functional cleanup read back 0 versions and 0 delete markers; private restore directories were absent. The whole run prefix remains PENDING-OBSERVATION with exactly two dedicated lifecycle keys (three noncurrent versions, one current version and one delete marker). No public listener, container or database was created.

Remaining: two new fresh FULL reviewers, canonical Mac verification, neutral PR and receipt-readiness. Native reviews/cycles have not started; no finding cards, PR or queue entry exist. S1 freeze remains active. After elapsed observation, direct old-version absence and whole-prefix cleanup must pass before any lifecycle PASS claim. The parcel is idle between the stated observation times; no lifecycle daemon is running. Resource teardown remains owner-held.

Self-retro: early seeding removed implementation time from the lifecycle wait. Mac load gating delayed the build about 2 minutes and lint about 3 minutes before proof moved to the permitted worker. The worker's direct test-wrapper launch initially lacked its local binary PATH and failed before tests; adding the worktree binary directory resolved it without a source repair. Existing npm test entrypoints supply that PATH. Along with the empty-body CLI correction above, these were two setup interventions; neither reset lifecycle evidence or spent a native review cycle.
