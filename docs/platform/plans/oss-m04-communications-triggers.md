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
re-exports; its Stripe verifier and tolerance remain local and unchanged. SQL is
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
| HTTP helper | Synthetic stream/fallback/cap, exact refusal bytes and hex-HMAC dialect tests; unchanged Stripe witnesses cover the delegating payment donor |
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
contracts and unchanged Stripe witnesses passed together (35 cases). Run 2's
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
Stripe runtime nodes. The supervisor owns commits and native review; this author
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
