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
The payment webhook donor remains untouched pending a path extension. SQL is
limited to three exact existing projections, with no migration or manifest edit.

## Verification ledger

Admission baseline: **8,275 required runner cases / 595.6 s** provisional summed
file medians. The cumulative M04 allowance is **+100 cases / +30 s**, including
newly selected existing witnesses. This is not a fresh allowance per PR.

| Property | P1 evidence / retained obligation |
| --- | --- |
| Existing public outputs | Unchanged reference tests for Auth email, transport/rendering, signatures, consent/status, sync, webhook/poll, token, receipt and ledger behavior; required selection only grows |
| Contracts/module boundary | Existing package-boundary/import-map plants plus synthetic type-only contract check; actual export inventory in the cold consumer |
| SQL identity | Three canonical/projection byte, digest and manifest-position comparisons; no new install chain |
| HTTP helper | Synthetic stream/fallback/cap, exact refusal bytes and hex-HMAC dialect tests; payment donor unchanged |
| Contribution | Host-selected schema and dependency identity, no default route/handler/schedule activation |
| Installed artifact | Existing required package gate, SDK-absent imports/refusals, declarations in NodeNext/Bundler, selected SDK and real PostgreSQL receipt replay/conflict/ACL proof |
| Browser continuity | Public-reference subscription profile build, browser-used value closure retained |
| Budget and size | Measure candidate case additions, timing and dry-pack bytes/files; no caps or gates relaxed |

Local command results, counts, candidate pack sizes, unavailable proofs and
cumulative budget usage must be recorded before supervisor admission. A clean
signed candidate is required by the package producer; an uncommitted local run
cannot replace that gate. Missing proof or an exceeded allowance remains a blocker.

## Local author status

The pre-commit focused pass executed 1,012 cases in 68 files: 1,011 passed and one
new helper test failed during fixture construction, before entering production
code. The fixture was corrected; its rerun and the later browser-only contracts
compiler assertion remain pending. The unchanged reference witnesses in that
pass were green. This is not complete candidate acceptance.

The observed P1 minimum is **+340 newly required cases**: 176 in newly selected
existing files, 156 from the existing three per-source boundary guards across 52
new source units, and eight synthetic package cases. Five more newly selected
files have not been counted by execution. This minimum already exceeds M04's
cumulative +100 allowance by 240; no selection was removed to hide it. Three
comparable timing samples, the +30 s calculation and actual candidate dry-pack
sizes remain unavailable.

The resource broker admitted the focused pass after 2,127 s, then stalled again
before the corrected test and complete early pass could start. The queued retry
was canceled; no verification remains running from this author task. Root lint,
typecheck, required/full suites, subscription build, packed consumer and real SQL
proof remain owed. The exact package producer also requires the supervisor's
clean committed candidate. The policy CLI refuses the untracked additions; its
candidate diagnostic additionally identifies the required-test command mirror
that needs a bounded companion-path extension. No git-state or control change
was made. The owner must resolve the case allowance before admission; elapsed
queue time and focused results do not waive any required proof.
