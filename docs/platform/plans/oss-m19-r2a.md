# Starter authenticated recovery checkpoint

Outcome: separate recurring payment recovery from initial checkout, preserve one
private rendered message per command across restarts, and authorize retry of the
same owned unpaid obligation using native server facts.

Scope: starter host capture, checkout admission, authenticated customer and human
operator recovery bindings, the corresponding client continuation and focused
proof. No package, SQL, release/control, provider or live subscription changes.
The required browser journey stays unchanged. Notice dispatch and renewal jobs
belong to the adjacent composition; richer lifecycle policies remain named
interim limits. Real payment-method setup remains unavailable.

Authority and delivery: the assigned implementation worker builds locally on
`5cabc00d4b84121c16ed15c641735fb50e92717f`, with policy read from main
`2245d037d55dbe4e324e630da851402d9efccd1c`. Local unsigned WIP snapshots and a
private decision packet are permitted. Stop before DCO, independent review,
submission, merge or release. The sensitive design requires coordinator read.

Acceptance: recurring relations are refused by every initial-checkout ingress
for guests and matching owners; authenticated recovery requires the positive
owned case/obligation/operation/order chain. Canonical UUID comparisons retain
input spelling. Token capture precedes requests and login; public outputs carry
only neutral state and refusal codes. Retry authorization is pending truth;
only the native driver can execute the original obligation. Captured artifacts
use exclusive durable publication, keyed readback and private permissions;
changed, corrupt or missing retry artifacts refuse without regeneration.

Proof plan: real restricted PostgreSQL and HTTP boundaries in both demo
configurations, native refusal/replay and restart witnesses, captured-file
faults/concurrency and browser entry cleanup. Measure long database cases and
set explicit bounds. Run whole script scanners, lint, built export tests,
neutrality, publication/type checks, structural checks, starter strict build and
both browser configurations. Report inherited scanner drift separately without
repair. Starter changes contribute zero packed package bytes.

Risk: shared bearer contexts, ambiguous capture/issuer acknowledgments and
untrusted method facts can cross authority boundaries. Reuse existing native
owners and receipts; do not introduce another token ledger or payment executor.
Smallest adequate alternative: an order relation fence plus existing retry
store and one file per message, replacing append-only capture.

Progress: implementation and proof in progress; no passing review or complete
journey claim. The private packet carries exact source mapping and evidence.

Implementation rethink: two database fixture runs stopped at host admission before
any scenario. The first fixture used a password-bearing URL; the second removed
the password but retained the unsupported URL scheme. Both were deterministic
fixture-input defects, not OOM, timeout or spawn/network retries. The fixture
now follows the existing host UUID proof's exact URL construction and validates
its arguments through the host parser before spawning. Next discriminating
step: parser acceptance followed by actual HTTP readiness. Lost startup detail
will be retained privately. Lesson: fixture launch refusal → validate the exact
existing CLI contract before another database run.

<!-- openlup-task-doc-impact {"unit":"tests","doc":"CONTRIBUTING.md","anchor":"#development-preview-checks","digest":"sha256-b5d615e85250547f044f78087ace0eb2e75ca28994174dd153316757b37b66cc","reason":"The added starter witness uses the existing tests/postgres Node root, existing container lifecycle and installed migration runner, and an explicit Playwright recipe. It changes no discovery, required command, fixture privilege, timeout default or contribution instructions. The tests owner already describes these proof locations and bounded per-case timeout conventions; local measured results and the native permission blocker belong to this task."} -->

Retry-proof rethink: the HTTP/restart proof reached authorization, then an
isolated native retry diagnostic identified an invalid synthetic method-evidence
reference. The simulator requires its existing sandbox namespace. Correcting
that fixture value produced one successful native retry per configuration with
zero query errors; no production or native contract changed. The complete
restart proof is rerun with that value. Lesson: invalid fixture facts → use
the selected simulator's existing fact contract before changing composition.

Measured PostgreSQL proof bounds: checkout fences took 0.85–1.57 seconds, with
a 10-second per-case bound matching the adjacent HTTP witness. Authenticated
restart/replay reached retry execution at 121.55–121.81 seconds, including two
native one-minute sign-in cadences; its bound is 180 seconds. Browser wrappers
took 9.13–9.92 seconds per configuration; their bound is 30 seconds, about three
times measurement. The blocked operator proof retains its provisional
60-second bound and needs a successful measurement after its native prerequisite
is supplied. No global timeout or gate budget is changed.

Checkpoint evidence: the selected real PostgreSQL/HTTP suite passed eight cases
across both configurations, including canonical UUID fences, wrong subject and
case refusals, expired/revoked/used credentials, actual authorization/replay
across host restarts, exactly one native retry execution and recovered readback.
The two operator cases were deliberately not rerun after the installed native
permission blocker was established; they remain ordinary positive tests in
source and remain required. This is not a passing whole-suite claim.

Both browser configurations passed all 50 tests each, with zero skips or retries:
the required journey file is unchanged, and the separate recovery proof checks
active recurring tokens on guest and same-owner completion pages, synchronous
URL cleanup, native sign-in and pending retry authorization. Final measured
case times were 0.87–0.93 seconds for fences (10-second bound), 121.55–121.63
seconds for restart/recovery (180-second bound), 1.88–2.25 seconds for unusable
credentials (10-second bound), and 8.70–10.76 seconds for each complete browser
wrapper (30-second bound). No global timeout changed.

The 58-file scanner set remains red only on inherited registry drift: 1,254
passing assertions, 16 failing assertions with the same inherited titles, three
suite-load errors and one pre-existing pending assertion. No new scanner failure
was found; the five earlier toolchain-sensitive verification assertions pass on
the official Node version. Built-dist checks passed 3,094 assertions across the
eight selected files. Publication typechecking reports zero unresolved edges and
zero consumer errors. Lint passed with zero errors and 33 inherited warnings;
starter strict compilation/build, 202 source/extracted tests, neutrality and
structural checks passed. Publication policy/docs navigation reports two owner
obligations and zero unanswered. No package files changed: package contribution
is zero bytes; no new pack or published-artifact qualification is claimed.

Stop boundary: the restricted native operator command requires receipt row-lock
permission absent from this installation. Its successful issuance, artifact
capture/replay, missing-artifact and active-operator handoff proof remains
blocked until its native owner supplies the prerequisite. No grant, owner
fallback or package repair was added. The sensitive host checkpoint requires
coordinator read before DCO. No review, canonical verify, submission or release
has run, and full row completion is not claimed.

Self-retro: exact CLI admission and the simulator's existing fact schema should
have been checked before the first database journey. Isolating the native call
identified fixture errors without weakening controls; keeping one artifact and
native receipts avoided another token ledger. The actual restricted login also
exposed the upstream operator permission prerequisite before any delivery.

Instruction freshness at handoff: main was fetched as
`6979704a5247b1f572b2cbbd8dce487ca37eff88`; the applicable agent/contribution/AI
policy paths have no delta from the starting policy pin. The implementation
base remains the frozen starter integration; no freshness merge was made.

The existing 24-case guest/customer UUID regression also passes. The strengthened
fence witness reads the real initial acquisition cycle after payment and proves
its absent renewal operation still permits guest and owner continuation. Token
capture runs before bootstrap requests and before route rendering, including
internal message-link navigation without a document reload. The separate
browser proof exercises both entry paths; the required journey remains unchanged.
