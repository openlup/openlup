# W1: a working subscription account reference

Status: approved implementation plan, development preview, 2026-09-23.
Audience: contributors implementing and verifying the disposable Node + Supabase profile.

## 1. Outcome and boundary

An independent evaluator purchases one recurring synthetic product, signs in with
real local Auth, reads their own order/subscription, confirms a renewal/charge date,
and sees the persisted result after process restart. A scoped operator can read
that result. All payment and communication providers are captured and have no
external egress. The selected date is planned renewal/charge, never a delivery
promise. Existing subscription/payment/delivery semantics remain authoritative.

One shared account lifecycle hook owns authenticated loading, mutation, refresh
and their distinct outcomes. An existing adopter replaces its dashboard lifecycle
with that same hook and retains presentation and diagnostic callbacks. The current
public date modal and action client are reused, not claimed as new extraction.
No generic plugin system, provider matrix, new preview protocol, stable-framework
claim, automatic repository synchronization or production deployment is included.

## 2. Concrete implementation scope

The first implementation batch owns:
- `src/domains/customers/useAuthenticatedAccountLifecycle.ts` and its component tests;
- a focused `src/public-reference/SubscriptionAccount.tsx` and separately
  selected subscription entry, leaving the static `App.tsx`/`main.tsx` intact;
- `server/runtime/public-reference/serve.ts` and explicit subscription-profile routing;
- existing checkout/payment-control/identity reconciliation/action ports, composed
  only for the selected profile, with focused runtime tests;
- a minimal public disposable Supabase setup/seed and installation instructions after
  baseline replay proves the exact prerequisites;
- public source-release producer and catalog/contract policy updates necessary
  for the actual new closed inventory, old-release authentication and refusal;
- standalone core package consumer-test baseline repair and actual CI ownership;
- relevant public owner docs and one complete stateful HTTP/UI acceptance journey.

The first runtime batch adds `server/runtime/public-reference/subscriptionProfile.ts`,
`subscriptionAccount.ts`, `capturedCheckout.ts` and focused sibling tests. It modifies
`server/runtime/public-reference/serve.ts` to select that profile explicitly. Browser
files are `src/public-reference/SubscriptionAccount.tsx`, `subscriptionApi.ts`,
`subscriptionMessages.ts`, `subscription.css`, `subscription-main.tsx` and focused
tests; the existing modal prop is narrowed to fields it actually uses. The static
`App.tsx` and `main.tsx` remain the default entry. `vite.public-reference.config.ts` and
`config/public-reference-subscription-imports.json` declare its exact shared import
closure while retaining the static entry's current guard.
The existing checkout adapter stays unchanged: a configuration conflict with a
persisted payment outcome refuses before writes, and capture time comes from the
persisted attempt. An attempted optional adapter override was rejected by automatic
approval review as outside the worker's owned files; the selected composition
does not require it.
Bootstrap owns `scripts/public-reference/setup-subscription.mjs`,
`scripts/public-reference/subscription-prereqs.sql`,
`scripts/public-reference/subscription-seed.sql`,
`scripts/public-reference/verify-subscription.mjs` and
`config/public-reference-subscription-supabase.toml`, following the successful
disposable managed-baseline experiment. `server/runtime/public-reference/subscriptionOperator.ts`
and its test provide single-order operator readback; `scripts/public-reference/grant-operator.mjs`
sets up only a confirmed local human operator. The selected stylesheet is
`src/public-reference/subscription.css`; existing modal tests receive explicit
test-local localization. `.github/workflows/published-tree-ci.yml` owns the selected
profile build/composition tests and the complete standalone core CI command.
Existing constraints remain: closed inventory/commands, authenticated
Git/receipt provenance, append-only migration compatibility and DCO commits.
Public implementation never imports a private registry, setup helper or governance
requirement. The public workflow and documented commands own its checks.

## 3. Cheapest falsifiers and stop conditions

First extract a typed controller and prove an actual adopter callsite deletes
loading/mutation/refresh logic while preserving cache, diagnostics and error behavior.
Reject a pass-through wrapper. In parallel replay the published managed Supabase
baseline in a uniquely owned disposable service; do not touch a shared database.
Resolve only demonstrated setup prerequisites, then exercise checkout, trusted
captured settlement, real sign-in/verified claim and owner-bound readback over HTTP.
Stop the affected route if it requires private setup, a broad schema/auth rewrite,
a new trust framework or weakened controls; consolidate concrete findings once.

## 4. Compatibility and implementation decisions

Keep the static reference profile as the default with its existing closed methods
and CSP. A server-selected disposable profile mounts only explicit routes with
proper auth/origin checks. Browser inputs cannot choose payment outcome, service
credentials or another actor. Reuse schema-5 receipts where sufficient; new inventory
is declared and exactly bound to real Git objects, never ignored. Old previews
remain authenticatable. Rehearse complete delta before immutable publication.

The owner explicitly approved the bounded compatibility amendment: three new
setup/operator/verifier entrypoints, the 28 added Git objects with their catalogue
classes, the current source-contract digest and nine changed target projection
digests. Implement this as a finite preview/4 to preview/5 transition in the existing
producer, pinned to the authentic prior receipt and exact target object digests.
There is no caller-supplied delta API. Preserve old source evidence, authentication
and the schema-5 reader. Package and lock bytes, migrations, database types, policy
registry and previous path classes remain protected. Other releases retain the
existing refusal rules; this does not admit future undisclosed growth.

The lifecycle API is generic over the account data shape; cache identity is a
client concern and is never authorization. Tokens go only to the supplied reads
and writes, never events or cache keys. A committed write and failed refresh remain
separate observations. Existing adopter result/toast behavior is preserved through
its own callbacks; diagnostics cannot break a business operation.

## 5. Independent review

A clean-context nonauthor reviews the integrated source and its exact head after
focused checks. Review covers actual private deletion, two real consumers, no-egress
trust boundaries, cross-principal denial, persistence/replay/restart and release
compatibility. Agent review is not a forged GitHub approval or provider certification.

## 6. Verification

Start with the affected hook and existing account/date regressions, then public
policy/inventory/typecheck, build and relevant root tests. Run the core package's
own `ci` in its owning public job. One fresh disposable HTTP/UI journey proves the
wiring; existing domain suites prove mature internals. Test cross-user/expired-token
refusal, invalid/stale date, replay, double submit, captured refusal and restart.
No private SQL/service-role shortcut substitutes for a buyer action.

## 7. Delivery

Protected public review/merge/checks precede immutable source release. An adopter
selects the authenticated release deliberately and verifies a retained customization.
No release is complete merely because a local test passes. Current work is not
published, merged or a supported installation; record actual evidence here as it lands.

## 8. Current evidence and completion

Base is `cda8d207aa4d949d5d2223d1a824b87713337c5b`. At functional checkpoint
`9402d744`, locked installation and root tests passed (359 files, 2911 tests); the separately owned
core CI passes (37 files, 309 tests), including its packed consumer check. The
date-modal public localization fixture is repaired without changing its behavior.
All five public TypeScript projects pass with zero missing edges and zero cascades.
The selected runtime suite passes 43 tests, including the review repair for returned
and thrown Auth errors: generic unavailability, fixed padding, no provider detail.
The managed baseline replays in a clean owned disposable instance with explicit
prerequisites and synthetic seed. The public HTTP verifier passed captured settlement,
retry/concurrency identity, genuine buyer/operator Auth, owner-bound account/date
mutation, invalid-date/outsider refusal and scoped human-operator readback. After a
Node restart, new Auth sessions read the same paid order, subscription and date.
A separate browser buyer completed checkout, captured email confirmation, account
selection, existing modal summary and confirmed renewal-date change. After another
Node restart and browser reload, the same paid order and active subscription still
showed October 28, 2026; browser warning/error logs were empty.

The finite compatibility amendment is implemented at `913b36d0` and refined at
`f0992cb1`. A clean clone of the former installed and passed 359 root files / 2912
tests, the static and selected builds, all five compiler projects and all 309 core
tests. Review repairs in the latter passed 186 focused tests and all five compiler
projects. Its revised seed also passed a fresh owned installation, the HTTP
verifier and persisted readbacks after a Node restart.

Automatic approval review initially refused the producer extension and
three explicit entrypoint declarations; the owner subsequently approved the exact
bounded package. Review then refused a general caller-supplied delta API, so the
implementation uses only the finite transition described above. Policy and inventory checks pass
with 4,621 exact paths and the three new entrypoints. The preceding preview/4 has
also authenticated through the native GitHub reader, including preview/3, ancestry
and its six required successful public checks. The actual producer authenticated
that history and wrote local rehearsal receipts at both compatibility checkpoints:
4,621 paths, 452 drift rows, exactly nine changed target digests with preserved
historical metadata. Four real Git rehearsals at `913b36d0` refused dirty HEAD,
an undeclared addition, an unlisted entrypoint and changed protected package bytes
before creating an output. Independent review of that checkpoint found duplicated
test execution, repaired at `f0992cb1`; final exact-head review remains required.
These are local execution results, not protected candidate CI or publication.
Old-release authentication, the schema-5 reader and refusal before writing remain
unchanged. No immutable release, merged change, adopter installation, supported
installation or production-provider certification is claimed.


## 9. Core fixture portability follow-up

Status: implementation in progress, 2026-09-24.

The packed-consumer leakage test fixture must use the approved meaning from its
package's shipped `release-gates.json`. A separately hard-coded sentence can
become inconsistent with a retained audit/metadata pair and make a leakage case
fail at the wording check before reaching its intended scanner assertion.

Scope: `packages/core/test/consumerTooling.test.ts` and this existing plan.
Read the fixture meaning from the adjacent metadata file. Keep the audit's
independent exact-wording assertion, all 20 leakage cases and both invalid-wording
refusals. No runtime behavior, audit allowance, package metadata, dependency,
workflow or release identity changes are needed for this correction.

Acceptance: run the focused core test and full public required checks; verify
the same test against an earlier internally consistent audit/metadata pair.
A malformed or rewritten meaning must still refuse. Review the full delta of
any later source release separately; this correction does not authorize a release
or make an earlier immutable preview mutable. Exact-head review and final check
results will accompany the contribution.
