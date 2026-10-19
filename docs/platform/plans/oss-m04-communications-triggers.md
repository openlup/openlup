# M04 communications import

Status: development-preview implementation plan. Audience: platform reviewers
and hosts replacing the existing public communications implementation.

## Outcome and authority

P1 relocates the existing public server algorithms into the platform package with
zero observable reference delta. The task starts at `cf36b01`; local source edits
and verification are authorized. The supervisor owns DCO commits, native review
and any later submission. This task grants no push, merge, publication, release,
provider activation, credentials or deployment changes.

## PR graph and scope

P1 declares `./communications`, `./communications/contracts` and additions to the
existing `./http` once. The public stack is P1 → P2 transport → P3 content → P4 native
stores/handlers. Separately approved B1 egress behavior follows P2,
B2 content behavior follows P3, and B3 direct operations follows P4. Composition
joins those slices before any separately authorized set-version preparation,
release or adopter continuation. No later wave is implemented here.

P1 preserves the current public copy rather than importing newer adopter drift.
Reference shims bind renderer, environment observers, egress resolver, origin
configuration, shared delivery control and receipt transaction lane. Browser-used
renderer, preview/content defaults and support/template policy remain local;
contracts contain only browser-safe types/ports. Existing public invitation
logic, dunning words, token purposes, schemas, response/error bytes, send outcomes
and ledger order stay unchanged. Trigger catalogue, gifts, new providers,
identity implementation, control-plane adapter and deployment config are excluded.
The approved E2 extension is applied: the payment webhook donor delegates the
five generic HTTP helpers, retaining the original declared `VercelRequest` body
reader signature and the same function object. The other four names are plain
re-exports; its the payment provider verifier and tolerance remain local and unchanged. SQL is
limited to three exact existing projections, with no migration or manifest edit.

## Verification ledger

Admission baseline: **8,275 required runner cases / 595.6 s** provisional summed
file medians. The cumulative M04 authored-case allowance is **+100 cases**, including newly
selected existing witnesses and synthetic cases. Generated per-file iterations
of an existing parameterized boundary test are counted separately and do not
consume that allowance. The binding limit is **+30 s median hosted file time**;
a case overrun is acceptable when time stays within +30 s and the ledger records
it with numbers. The M04 post-loop clean-up must revisit it. These are the
coordinator's X2 interpretation, not a reset of the baseline or a gate change.

| Property | P1 evidence / retained obligation |
| --- | --- |
| Existing public outputs | Unchanged reference tests for Auth email, transport/rendering, signatures, consent/status, sync, webhook/poll, token, receipt and ledger behavior; required selection only grows |
| Contracts/module boundary | Existing package-boundary/import-map plants plus synthetic type-only contract check; actual export inventory in the cold consumer |
| SQL identity | Three canonical/projection byte, digest and manifest-position comparisons; no new install chain |
| HTTP helper | Synthetic stream/fallback/cap, exact refusal bytes and hex-HMAC dialect tests; unchanged the payment provider witnesses cover the delegating payment donor |
| Contribution | Host-selected schema and dependency identity, no default route/handler/schedule activation |
| Installed artifact | Existing required package gate, SDK-absent imports/refusals, declarations in NodeNext/Bundler, selected SDK and real PostgreSQL receipt replay/conflict/ACL proof |
| Browser continuity | Public-reference subscription profile build, browser-used value closure retained |
| Budget and size | Measure candidate case additions, timing and dry-pack bytes/files; no caps or gates relaxed |

Local command results, counts, candidate pack sizes, unavailable proofs and
cumulative budget usage must be recorded before supervisor admission. A clean
signed candidate is required by the package producer; an uncommitted local run
cannot replace that gate. Missing mandatory proof or an exceeded binding time
limit remains a blocker; case overruns follow the X2 interpretation above.

## Earlier run evidence (historical; not current acceptance)

Candidate `e9eca83` moved the communications implementation. Run 1's fixture
construction failure was repaired in run 2; the corrected helper, DOM-only
contracts and unchanged the payment provider witnesses passed together (35 cases). Run 2's
approved-access required/full suites failed only on the then-missing X1 mirror.
Its `readRawBody` declaration used `HttpRequest`; the supervisor subsequently
restored the original declared `VercelRequest` signature through E2. Neither
historic result establishes acceptance of the merged run-3 candidate.

Run 2 measured 101 existing witness cases, eight synthetic cases and 156 boundary
iterations, with 0.627054 s summed local file medians. Its aggregate +265 counting
and allowance-blocker interpretation are superseded by X2 below. The 2,127 s run-1
broker delay, restricted-context failures and rejected zero-case timing samples
remain in the original local reports; no native review budget is reset.

Run 2's real-PostgreSQL source proof passed; it was not installed-artifact proof.
Its dry pack measured 360,792 B packed / 1,463,614 B unpacked / 554 files, above
the then-current 196,608 B / 1,048,576 B / 256 files. Main `71a5200` both refreshes
and enforces the caps in `packages:check` and release preflight. Its platform
aggregate limits are now 522,240 B packed / 2,088,960 B unpacked / 800 files;
code limits are 440,320 B / 800 files and docs limits 40,960 B / 10 files. The
released baseline is 0.16.0 / 256,973 B; the identity contracts browser cap is
4,800 B. Run 3 preserves all of these controls. No new cap or cap change is
authorized; early-pass success cannot waive the clean-commit artifact gate.

## Run 3 merged candidate and X1/X2 ledger (2026-10-19)

Start: `1e8c7ce`, merge of `71a5200` into P1, after supervisor commit `8c51415`.
E2 is applied with seven original exported names and original declared signatures;
run 3 must compare against `cf36b01`, including same-object delegation and unchanged
the payment provider runtime nodes. The supervisor owns commits and native review; this author
run edits files only and stops for a commit before artifact admission.

X1 mirrors `package.json`'s required command in `PUBLIC_REQUIRED_TEST_SCOPE`:
20 run-2 retained selectors plus restored `api/auth-send-email.test.ts`. The Auth
entrypoint is the existing witness of the moved Auth hook/Standard Webhooks
composition and must remain selected. No original required selector is removed.
Catalogue command/execution digests, source-release contract and documentation
navigation are regenerated through their repository generators. The closed
execution-entrypoint inventory also needs these additive test registrations;
run 3 requested that bounded control-path authority when policy exposed the gap.

Fresh three-run local Vitest file measurements, with all selected cases passing:

| Category | Added cases / iterations | Summed per-file median seconds |
| --- | ---: | ---: |
| Existing required witnesses (21 files, including 3 restored Auth cases) | 104 | 0.068248 |
| Synthetic package cases (5 files) | 8 | 0.525857 |
| Existing parameterized boundary guard over 52 new files, separate | 156 | 0.063393 |
| Counted witnesses + synthetic | 112 | 0.594105 |
| All added runner work, including separate boundary iterations | 268 | 0.657498 |

The authored-case overrun is **12** (112 − 100), accepted under the coordinator's
X2 interpretation while the binding time limit holds; post-loop clean-up must
revisit these numbers. Boundary iterations consume no authored-case allowance.
The local proxy adds **0.657498 s**, leaving **29.342502 s** under +30 s;
adding it to the provisional 595.6 s baseline gives **596.257498 s**. This is
median per-file elapsed time from three identical selections, summed after taking
each file's median, including filtered boundary-file time. Queue and wrapper wall
time are excluded. It is local evidence for the hosted-time budget, not a fresh
hosted measurement. The supplied 8,275-case baseline is retained; current root
suite totals are not subtracted from it to manufacture an addition count.

Run 3 passes ast-grep, lint (zero errors, 33 warnings), all five typecheck
projects, the subscription reference build, real-PostgreSQL source communications
conformance and E2 exact declared-signature/runtime identity comparison against
`cf36b01`. Tracked inputs stayed unchanged throughout this serialized early pass.
Required selection records 7,653 passed / 2 failed / 0 skipped; the complete root
suite records 13,903 passed / 11 failed / 2 existing opt-in skips. These are
failing runs, not acceptance. No communications runtime witness failed.

The failures have three control/fixture causes. The native merge-preview fixture
reads committed HEAD, whose catalogue remains stale until a supervisor commit;
uncommitted regeneration cannot affect that fixture. X1's new explicit selectors
also need closed execution-entrypoint registrations and the public-check test's
exact required-command expectation updated additively. Missing registrations
cause the bare documentation and materialized-public fixtures to omit the new
targets. Finally, the merged cap test requires a browser cap for every declared
contracts entry; `./communications/contracts` has none in `release-gates.json`.
The author's grant forbids cap/control changes, so these remain owner/supervisor
blockers rather than a weakened test, dropped selector or invented cap.

Exact commands, all failures and proof artifacts are recorded in local
`p1-r3/report.md`. No commit request is issued while policy and the early suites
are red. Clean committed package artifact proof, enforced caps and native review
remain required after a separately authorized supervisor commit; no release or
adoption is claimed. Self-retro: check the closed execution inventory and exact
command witness together when adding required selectors; preserve the boundary
between file-level repairs and owner-controlled cap registration.

## Run 4 W1/W2 neutral conformance (2026-10-19)

Assigned clean candidate `afb3634222e3e74c94e94c7b433e01c01330c20f`; same task
worktree/branch. Extraction identity: adopter C1 merged #4397,
`a7a97fea6c00e42681fc2b680f3b5eb8a279b559`, extraction record §1.10.
Finite outcome: fresh neutral synthetic W1/W2 tests of the current public
communications implementation and generic HTTP reader contrast. Private tests
were read only for properties; no private code, fixtures, keys, addresses, brand
or IDs are contributed. Source behavior, controls, dependencies and selectors
are excluded. File edits and serial brokered verification only; no Git writes,
commit, native admission, submission, release or adopter activation. The
supervisor retains those later delivery responsibilities.

Acceptance/proof: exact public verifier dialects and clock/byte/key refusals,
hook stream policy, complete real transport/client outcomes and projections,
signal forwarding and in-memory capture. Isolate each named W1/W2 negative plant,
observe assertion failures, restore source bytes, then run ast-grep, lint,
communications tests, platform build and policy/navigation regeneration. Heavy
commands use `ai-resource-gate run --wait openlup:coverage --` with approved
Docker/npm-cache context. X1b registration failures remain a separately pending
control boundary. Reuse small parameterized suites and actual composition rather
than another runner or mocked public exports. Results and budget follow below;
local raw evidence is in `p1-r4/report.md` in the task scratchpad.

Fresh tests live under `packages/platform/test/communications/`, already selected
by the required package tier. W1 contributes **22** cases; W2 contributes **6**
(the private witness's five top-ups plus a separate public capture case), **28**
in total. No existing expectation or selector changed. The independent signer
uses fresh synthetic material and UTF-8 content; expected policies are stated
separately for Auth and the maintained HTTP mail provider, without asserting protocol equivalence. The hook
is reached through its real signature/payload boundary, with downstream effects
forbidden. The concrete transport delegates to the real the maintained HTTP mail provider client with a
synthetic fetch and explicit host egress resolver. No requested property differs
from the public behavior. Public environment tags and injected egress reasons
are pinned as public values, rather than importing adopter binding values.

| Witness / property | Fresh test | Plant → observed failing test |
| --- | --- | --- |
| W1 key forms, trimming and Auth-only versioned-secret parsing | `webhookDialects.test.ts`: six `key policy` rows | `auth-versioned-secret` → `key policy: 'versioned encoded secret'` and `'versioned literal secret'` (2 failures) |
| W1 rotation members, bare/v1/other-version grammar; original signed UTF-8 whitespace | `webhookDialects.test.ts`: three `rotation signature grammar` rows and `requires the original whitespace and UTF-8 bytes` | `auth-signature-bypass` → all three grammar rows + original bytes (4); the provider signature-bypass plant → those four plus whitespace/versioned-secret policy rows (7) |
| W1 Auth millisecond / the maintained HTTP mail provider second clocks, inclusive ±300 and refusal at ±301 | `webhookDialects.test.ts`: four `replay offset` rows | `auth-replay-bypass` and the provider replay-bypass plant separately → offsets -301 and 301 (2 each) |
| W1 malformed empty/prefix/punctuation/length/noncanonical-pad-bit keys | `webhookDialects.test.ts`: five `refuses unusable secret` rows, signed using permissively decoded material | Matching invalid-key HMACs refused by both public verifiers; signature bypass plants additionally exercise the independent comparison boundary |
| W1 stream precedence, drained stream with no fallback, uncapped Auth stream vs capped generic reader | `hookRawReader.test.ts`: three `Auth raw reader` rows; exact 400 envelopes/no downstream effects; generic reader contrast in each row | `hook-generic-cap` → `Auth raw reader: large stream` (1) |
| W2 whole missing-ID, sanitized coded rejection, thrown/aborted results and projections | `transportConformance.test.ts`: four `concrete send` rows | `omit-provider-error-code` → `concrete send: 'sanitized coded rejection'` (1) |
| W2 suppression means skipped, no network | `transportConformance.test.ts`: `suppression records a skip and performs no fetch` | `suppression-as-sent` → same test (1) |
| W2 original AbortSignal reaches actual fetch | `transportConformance.test.ts`: all four concrete send rows | `lose-abort-signal` → all four concrete send rows (4) |
| W2 complete ordered capture and whole outcomes, no fetch | `transportConformance.test.ts`: `in-memory capture retains complete ordered envelopes and outcomes` | `lose-capture` → same test (1) |

All **10** isolated plants exited 1 with assertion failures. Each plant restored
its source in `finally`; all communications/HTTP source bytes matched the initial
snapshot after each plant and before final checks. `plants.json` retains the
complete failing-test map and SHA-256 inventory. Final Git diff confirms zero
runtime/control changes. No native review cycle, expiry or retry budget changed.

Final restored-source checks: ast-grep **PASS**; lint **PASS** (0 errors, 33
existing warnings); communications package **7 files / 32 cases PASS**, including
all 28 new cases; platform build **PASS**. Three subsequent identical new-file
selections each pass **3 files / 28 cases**. Publication policy with
`--policy --docs-update` exits 1 solely on the pending **X1b executable-registration**
family: `server/adapters/captured/transactionalDelivery.test.ts` is not registered.
The check stops at that refusal; no completed navigation regeneration or later
policy-stage success is claimed. Controls were left unchanged.

| New file | Cases | Three local file-time samples (s) | Median (s) |
| --- | ---: | --- | ---: |
| `webhookDialects.test.ts` | 19 | 0.003110107 / 0.003113037 / 0.003124023 | 0.003113037 |
| `hookRawReader.test.ts` | 3 | 0.008456299 / 0.008108398 / 0.007738770 | 0.008108398 |
| `transportConformance.test.ts` | 6 | 0.011354248 / 0.012185303 / 0.011187744 | 0.011354248 |

New-file summed median = **0.022575684 s**. Cumulative counted additions:
104 existing witnesses + 36 synthetic = **140 cases**, **40** over the +100
allowance under the recorded X2 interpretation. Existing generated boundary
iterations remain **156**, separately counted; total runner additions **296**.
Counted-case file medians now total **0.616680909 s**; including the
unchanged boundary-file median gives **0.680073487 s**, leaving
**29.319926513 s** against +30 s and a provisional baseline-plus-delta of
**596.280073487 s**. The prior run's medians remain attributed to run 3;
only these three new files were freshly measured. Local Vitest JSON per-file
`endTime - startTime` medians are summed after taking each file's median; queue,
wrapper and plant runs are excluded. This is local proxy evidence, not new
hosted timing. Post-loop cleanup must revisit the case overrun.

Delivery: requested test authoring and bounded verification are complete; X1b
policy acceptance remains pending with its existing owner. No Git writes or
external actions. Terminal self-retro: no test repairs or resource queue delays
were needed. Keeping the generic-reader contrast inside the three hook cases
and forwarding through the actual client avoided extra cases and a test-only
transport abstraction; the separate capture case explains the 28-versus-27 tally.


## Run 7 neutral authorship and selection narrowing

Supervisor A/B/C refine P1 without changing the neutrality ratchet or controls.
New package prose is neutral; reference shims keep the deployed provider kind,
HTTP endpoint/error label, timeline default and callback/poller source values,
then pass them to the extracted functions. Reference provider types keep their
literal; package contracts accept a host-supplied provider type. These are host
composition parameters, with no output or algorithm change.

All four required-command mirrors remove only six P1 additions: the redundant
Auth API selector, three provider-path timeline/ledger/skip witnesses and two
provider-path key/verifier witnesses. No pre-P1 selector is removed. Neutral package
conformance cases characterize the same timeline, logging and key-order boundaries;
W1 covers the provider verifier and hook reader. Existing reference tests remain
in the complete suite. The run-3/run-4 tables above are historical observations;
the final run-7 ledger below supersedes their selection counts.

Fresh run-7 measurements: three identical selections, all passing, with each
file's local Vitest elapsed median summed. Queue/wrapper time is excluded;
these are local proxies, not new hosted measurements.

| Category | Cases / iterations | Summed file medians (s) |
| --- | ---: | ---: |
| Retained existing witnesses (15 files) | 79 | 0.052050781 |
| Synthetic package witnesses (7 communications files plus HTTP helper) | 56 | 0.509342041 |
| Counted additions | 135 | 0.561392822 |
| Boundary iterations, separate | 156 | 0.063640381 |
| All added runner work | 291 | 0.625033203 |

Counted cases are **79 + 56 = 135**, a **35-case overrun** of +100 under X2;
post-loop cleanup must revisit it. The binding +30 s allowance has
**29.374966797 s** remaining; provisional 595.6 s baseline plus delta is
**596.225033203 s**. The six removed additions account for 25 cases; neutral
replacement cases add 20. All pre-P1 selectors remain selected.

Run 7 required suite: **7,678 passed, no failures or skips**. Complete suite:
**13,960 passed, 2 failed, 2 existing opt-in skips**. Both failures are the
excluded documentation CLI fixture: its seed registers only the demo domain but
materializes the retained communications test entrypoints, so source-map creation
refuses an unregistered communications domain before either assertion. Removing
the Auth selector resolved the earlier unknown-path failure; it did not settle
this separate fixture obligation. No fixture, router or assertion was changed.

Generators, documentation policy, ast-grep, lint (0 errors, 33 warnings), all
five typechecks, subscription reference build, source real-PostgreSQL proof,
both neutrality scripts and E2 comparison against `cf36b01` pass. The public
neutrality check reports **zero increases**, with baseline/scanner unchanged.
Exact comparisons against committed run-6 source confirm all five host
parameterizations retain reference requests, responses, RPC arguments and event
metadata. Reference provider type bytes remain identical to the P1 base.

The full-suite fixture failure remains a delivery blocker outside this run's
scope. The clean-commit package artifact gates remain the supervisor's next step;
no fresh artifact admission, native review or external delivery is claimed.

Self-retro: the materialized inventory refused untracked test files while Git
writes were forbidden. Reusing the existing neutral conformance file removed
that inventory change and preserved every replacement assertion. The Auth
selector removal exposed a second fixture seed assumption; report the concrete
scope blocker rather than silently remove more retained witnesses.
