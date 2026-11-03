# M19 G5: native checkout persistence

Status: transfer receipt draft awaits its owner read before DCO/native review (development preview).
Audience: money-stream supervisor, implementer and independent reviewers.

## Outcome and authority

Persist a trusted host-produced quote as a native qualified-v2 order draft,
through the installed experimental `commerce/server/native-checkout` export
and restricted runtime login. Preserve complete quote and derived draft money
snapshots for order-detail readers; matching/concurrent replay has one effect,
changed input refuses, and a new process recovers the durable receipt. A browser
return never establishes paid truth.

Worktree `oss-m19-g5`, branch `codex/oss-m19-g5`. The accountable maintainer
allows local implementation, DCO-signed commits and independent native review.
This run stops before canonical verify, push or PR creation; the lead names
that next step and owns acceptance, caps and landing order. DCO author is
Bart Roszkowski <dev@openlup.com>. No release, publication, production,
credentials, settings, cost or control changes are authorized.

## Smallest complete scope

One structural executor adapter, one parameterized call to the existing
`commerce_create_promoted_order_draft_with_outbox`, explicitly serialized JSON,
and existing quote/schema/error types. Derive the draft from the same quote;
do not accept independent money records. The incumbent TypeScript draft port
has a supersession fallback, so direct reuse would break changed-input refusal.
The separate opt-in entry keeps the existing port and managed rail unchanged.

The host supplies the quote and separately authorized client ID. This adapter
does not authenticate or produce authoritative quotes. Catalogue-drift refusal
comes from the existing SQL routine. The stored receipt describes draft creation,
not current paid truth. Existing net-shipping, line-discount and zero-payable
refusals remain. No configurator persist-intent or policy is invoked.

No SQL forward, schema/privilege/object change, price writer, payment dispatch,
attempt storage, activation, renewal, destination, inventory or notice work.
The unchanged native routine retains `commerce_orders.metadata.quoteSnapshot`
and `orderDraftSnapshot`; it writes items, the receipt and draft outbox fact
atomically. Managed migrations and existing commerce/server implementations
are untouched by G5's own delta.

Because checkout first populates the existing draft receipt on this native
rail, its row also joins the existing finite capture/restore profile. The root
adapter lists, owner explanation and transfer proof are shared additive edits;
the profile change awaits its required owner read before commit.

G5 writes neither `supersededByStableJourneyKey` nor `checkoutAbandoned`, and
adds no location for a dispatched attempt. Native abandoned-order compensation
is a later follow-on, not G5. The generic adapter still calls the undefined native
`commerce_cancel_abandoned_checkout` and fails closed with `42883`; the existing
native `commerce_compensate_abandoned_checkout` has a different name and writes
no withdrawn metadata marker. Binding and proving native compensation remains
required before the overall money path counts it. Any future native withdrawn-
marker writer must add the OMS dispatched-attempt clause in the same PR.

## Forced integration

Review base and trusted policy source: main `46c3e8b2e063407ce27a914828c9548fff8b92ae`.
A single DCO-signed merge incorporated main; G5's changelog note then moved
verbatim to a fragment in a separate DCO-signed commit. CHANGELOG matches main.

| File | Conflicted shape | Resolution |
| --- | --- | --- |
| Publication catalogue | Three disjoint path groups: task records, API snapshots, PostgreSQL tests | Retain main order and all rows; add only G5's four rows |
| Package boundary test | One closed nested-entry literal | Retain all main entries; add native checkout after commerce/server |
| Changelog | One Unreleased insertion | Keep main verbatim; move G5 note to its fragment |

Full own-delta patch-id before: `3f7bff6e2e981161462d838837a39e06e46304f4`; after merge: `697a9992478346d20419a6485bda92d7c85f3d96`.

Excluding task record/changelog, before: `ca3292c11ac91f95bd093985e561264f8371d7a3`; after: `0888b8deecd4277a9b8435580bf3b4f5623f31f3`.

Commands: `git diff <base> <head> | git patch-id --stable`, repeated against
merged main with the stated exclusions. IDs differ because allowed shared-list
line/context changes and note migration change the patch. This is not claimed
as Git's conflict-free mechanical case. The production source and API snapshot
are byte-identical to the accepted pre-merge G5 blobs; export values and cold
entry are preserved. The subsequent test-only repair replaces registry peer
specs with locked local tarballs and logs the actual session TimeZone. No new
API/source/budget semantics require a renewed read.

## Official real-pack measurement

Independent archives of main and candidate, same official Node v24.21.0 and
npm v11.19.0, normal internal build/prepack order, real npm pack, and the shared
package-size policy measured the actual extracted tarball. Inherited packaged
SQL and manifest bytes are included. G5 adds no SQL.

| Measure | Main | G5 | Delta |
| --- | ---: | ---: | ---: |
| Packed bytes | 2,435,777 | 2,439,455 | 3,678 |
| Code-class gzip | 1,950,344 | 1,952,891 | 2,547 |
| Unpacked bytes | 11,454,327 | 11,467,472 | 13,145 |
| Files | 3,021 | 3,024 | 3 |

All caps pass; no numeric gate changes. The three added packed files are the
source entry, runtime JS and declaration. Fragment, task record and root tests
are not packed. Later proof-only edits do not change any package input.
Estimate remains 1–2 working days including proof/review and delivery.

## Every G5 time use

| Site | Classification | Reason |
| --- | --- | --- |
| Production request, SQL parameters and response | None | No named time fields, clock, Date conversion or timestamp comparison |
| Opaque host quote context | Not a platform time contract | Persisted unchanged; the host owns any additional facts |
| npm subprocess bound | VALUE, duration | 120 seconds; execution only |
| TypeScript subprocess bound | VALUE, duration | 120 seconds; execution only |
| PostgreSQL setup/teardown hooks | VALUE, durations | Existing shared bounded fixture lifecycle |
| Fresh-process subprocess bound | VALUE, duration | 15 seconds; execution only |
| Restart-case timeout | VALUE, duration | Existing 30-second case bound |
| Transfer child / transfer-case bounds | VALUE, durations | 30-second child and 60-second case; execution only |
| Transfer timestamp fixture | VALUE | Exact six-digit instant assigned to the writer-created typed SQL column |
| Transfer timestamp audit | IDENTITY, proof only | SQL renders UTC with six fraction digits and Z before exact assertion |

Production VALUE 0, IDENTITY 0: the transfer additions only name the table in
existing lists. Eight proof-duration call sites are VALUE and none is persisted
or used as a money key. The transfer proof audits a canonical SQL time and the
existing UTC JSON row round trip; no production time conversion is added.
All five checkout real-PostgreSQL cases pass in default,
Etc/GMT-9 and Etc/GMT+5 sessions; SHOW TimeZone confirms each runtime setting.

Each new PostgreSQL case also ran solo, without coverage:

| Case | Solo seconds | Timeout |
| --- | ---: | ---: |
| persists complete one_time money and arrays, replays concurrently and recovers from a fresh process | 0.143 | 30,000 ms (existing) |
| persists complete subscription money and arrays, replays concurrently and recovers from a fresh process | 0.133 | 30,000 ms (existing) |
| refuses catalogue drift and an unprivileged caller without partial effects | 0.028 | 10,000 ms (default) |
| rejects malformed money, identity injection and browser-return payment fields | 0.026 | 10,000 ms (default) |
| retains the native zero-payable, shipping and line-discount refusals | 0.019 | 10,000 ms (default) |

These five checkout cases stay below 3 seconds. The added transfer case measures
15.06 seconds solo and uses a commented 60,000 ms timeout. Common fixture work
remains under the shared explicit hook budgets.

## Proof on the integrated tree

The PostgreSQL witness imports the public export from installed tarballs,
compiles NodeNext/Bundler types, uses the restricted qualified-v2 runtime role,
and denies schema creation and privilege escalation. Synthetic catalogue,
prices and identity are fixture setup; orders, items, receipts, settlement and
payment-truth facts are never hand-written. Both purchase modes retain all
money, tax, arrays and host context; concurrent replay/restart/changed quote
and client, invalid money, browser-return fields and money limits are proved.
The peer-present phase now installs only the packed locked dependency closure
offline, with a fresh cache supplied outside the test.

| Required proof | Passed |
| --- | ---: |
| G5 PostgreSQL default / GMT-9 / GMT+5 | 5 / 5 / 5 |
| G5 solo PostgreSQL cases | 5 |
| Complete commerce tests | 112 files, 887 cases |
| Package boundary | 2,945 |
| ESLint import map | 123 |
| Outcome projection | 7 |
| Documentation CLI | 3 |
| Existing importer tests (excluding G5) | 8 files, 154 cases |
| Broad total, no failures | 124 files, 4,119 cases |
| Neutral starter | 176 |
| Platform API check | All experimental surfaces |
| Root strict typecheck | 0 unresolved edges, 0 consumer errors |
| Ast-grep / both neutrality checks | Pass; no baseline increases |

The Linux/glibc full cold consumer passed in 101.69 seconds on Node v24.21.0 /
npm v11.19.0. Its independent empty cache and all install phases used local
tarballs only. A scratch npm launcher maps the existing peer phase's exact locked
specs to its packed closure and forces offline installation; the consumer source
and every import/declaration/adapter/SQL assertion remain unchanged. Linux-native
optional packages were prepared from the lockfile before the proof, separately
from the empty consumer cache. The full starter, optional-peer and installed
PostgreSQL proofs executed. Initial preparation assumed obsolete Rollup instead
of current Rolldown; that scratch setup was corrected before the one proof run.

The changed-source test importer inventory is the cold-consumer test, reference
invoice consumer, channel/inventory/catalogue consumers and promotion/acquisition/
account PostgreSQL consumers, plus G5 itself. Every existing importer ran unchanged.
The fresh proof logs and JSON summaries remain in ignored local scratch.

Gitleaks scanned all WIP refs: 1,773 commits / 87.61 MB, no leaks. Full lint,
policy/navigation, final signed-candidate registry/admission preflight and fresh
native review are recorded in the completion section below. No canonical verify
has been run and no submission is authorized here.

## Process accounting and next gate

The same append-only native history retains one consumed repair cycle. This
forced, conflicted integration and full refresh use normal accounting; prepare
with the updated intent must preserve that history and advance to cycle 2 of 3.
No old review evidence is inherited. Two new full reviewers assess the complete
diff from main, with an independent complexity challenge and documentation
assessment. Stop on needs_owner rather than resetting the history or budget.

Self-retro: one narrow native query adapter remains sufficient; the probe avoided
a new SQL forward. Locked local tarballs remove cache-dependent registry behavior,
and per-case timing distinguishes fast assertions from the common install/setup
hook. The forced merge's shared-list changes are explicit, rather than treated as
an identical patch. Canonical verify, PR creation and delivery remain lead-gated.


## Connected-store profile gap and assigned draft

The current native draft routine writes `commerce_order_draft_receipts`; the
installed G5 witness proves that receipt is nonempty after purchase. Main's
finite connected-store capture profile lists orders, items and outbox facts,
but not this receipt table. Its unknown-nonempty census rejects any nonempty
public table outside that profile with `PostgresTransferError("unsupported_table", "public.commerce_order_draft_receipts")`. The restore
path likewise has no receipt mapping. A native checkout store would therefore
lose the existing transfer promise before capture, even though draft persistence,
replay and restart work.

The money-writer brief explicitly makes a newly written unlisted table part of
the row, and the profile header requires its identity/operations owner read.
The prior run stopped before editing capture/restore. The maintainer now assigns
G5 its additive lines in these shared files; whichever row lands second unions
them. The receipt draft below remains uncommitted for the required owner read.
No native review, canonical verify, PR or submission has been attempted.
The native session remains at cycle 1 of 3; the planned refresh has not yet been
prepared. The assigned finite receipt addition and its transfer/replay/identity
proof now await the domain/identity/operations owner read before G5 can proceed.

The receipt holds idempotency key, request fingerprint, order UUID, response
payload and created_at. The payload duplicates the accepted quote and may carry
opaque host context; restore must assess customer/order remapping and the
fingerprint, rather than blindly copying or deleting the receipt. No new field
or receipt table is proposed.

Self-retro: the full cold consumer and SQL snapshot proof covered installation
and money facts, but did not make a purchased store transferable. Trace every
nonempty table the promoted writer reaches against the finite capture profile
before review; existing-table reuse can still require transfer ownership.


At the stop, the unchanged full lint command passes with zero errors and 99
existing warnings. Its first run scanned generated scratch archives; all 57
errors were in those fixtures. The archives were retained under the already
ignored scratch node_modules directory, without changing any lint rule or
candidate source. Policy and docs-update were executed; two no-impact trailers
for the existing contributor tests/tooling sections remain to be committed.
Native review, final admission/registry preflight and canonical verify remain
unrun. The blocking capture behavior above is established from the executed
nonempty-receipt assertion and current census implementation, not claimed as
an executed capture refusal test.


## Receipt transfer draft (owner read pending)

Add the existing receipt table to the finite owned capture list and restore it
after orders/items through the unchanged `insert` path. PostgreSQL serializes
and repopulates the row; no JavaScript Date or timestamp conversion is added.
The table count becomes 89 because only `commerce_order_draft_receipts` joins
the profile. The handover's current count literal changes 88 to 89; its current
schema hash and every historical pin remain unchanged. No table, SQL forward,
grant, schema, package source or public API changes.

Native restore preserves the order and client UUIDs; client import passes the
original ID and principal ID to SQL. Native principal rows and opaque quote,
draft and receipt JSON are copied unchanged. The stored decorated response order
UUID therefore still identifies the same order. The request fingerprint depends
on the quote JSONB, draft JSONB and client UUID; all remain exact. The optional
managed identity mapper is a separate function and is not invoked by native
restore. This draft adds no managed receipt/identity translation capability.

The new case creates its source checkout through the installed public factory
with the restricted runtime login, captures and restores to a clean qualified
target, then uses a fresh process and installed export to replay once. It checks
SQL recomputation of the fingerprint, order/client/principal IDs and embedded
identity facts, response payload parity with order metadata, changed-fact refusal,
one order/receipt/draft event and unchanged whole receipt rows. A precision-only
fixture UPDATE fixes the writer-created receipt's created_at to an exact
sub-millisecond instant; no order or receipt is created by hand. Its 15.06-second
solo measurement has an explicit 60-second timeout and comment.

The receipt is linkable customer/order data, including idempotency keys and opaque
host context. No privacy scrub or nonpersonal-content guarantee is introduced.
The owner-only transfer boundary and existing row/byte limits cover it; the new
case specifically exercises both limits at this receipt. No public read route,
service activation or browser/table grant is added. The adapter owner's finite
transfer section documents this same boundary.

Self-retro: preserving native IDs avoids a new receipt translator and SQL/JS hash
implementation. The minimal change is two list entries plus its proof and owner
explanation; remapping is unnecessary on this native-to-native path.


The transfer draft retains exact-profile validation. It expects 89 tables, even
when the receipt table is empty, and does not convert earlier 88-table packets.
That compatibility limit is explicitly part of the owner read; no missing-table
inference or replay-evidence deletion is added. The new test's context mode
needed a literal type assertion to match the existing public request type; this
was a test-only compiler correction with no emitted/runtime behavior change.

The completed transfer file passes 14/14 cases in each of default, Etc/GMT-9
and Etc/GMT+5; checkout passes 5/5 in each of those sessions. Five existing
transfer-importer files pass all 34 cases, including the existing restricted
qualified-admin fixtures. The new positive receipt case is qualified-v2; it does
not claim a new managed mapping or qualified-admin receipt witness.

The handover reaches LOCAL_QUALIFIED_TARGET_READY_WITH_ONE_FENCED_UNCERTAIN_OPERATION
in 99.994 seconds, with 97 migration units and 89 retained tables. Only the
receipt table moves the count. Two accepted effects recover, one uncertain
effect stays fenced, all publication/activation flags are true and cleanup has
no failures. The current catalogue hash remains unchanged.

A real official-toolchain pack is byte-identical before/after these root-only
edits: SHA256 4b5cd153af6c978dbe9e17a9bc10c480f4e2d80b2c45a140f01d8d32d068d16a.
The transfer delta is 0 packed/unpacked/code bytes and 0 files; absolute G5
remains 2,439,455 packed bytes, 1,952,891 code-class bytes and 3,024 files.
Strict typecheck, full lint, ast-grep, both neutrality checks and all-ref gitleaks
pass. The two earlier contributor no-impact policy answers are committed
separately with the already-proved checkout fixture change; the transfer draft
itself remains uncommitted for the owner read.

That separate DCO commit is c7148da0ba27f2032a3c7087cb48f3aa3076058c. Both
policy commands ran on the draft; the adapter owner section is answered, and
two new-delta no-impact answers remain pending for the handover count literal
and expanded tests unit. Their exact digests and proposed reasons are in the
owner-read packet; they can accompany the transfer commit only after acceptance.
No documentation/control baseline was relaxed to make the draft pass.
The final documented gitleaks command scans all 1,774 WIP commits with no leaks.
An extra default-rules invocation reported 34 matches because it omitted the
repository configuration; the configured check passed without any policy edit.

Self-retro: the new whole-file proof exposes the finite-profile change and its
older-packet limit before signing it. Preserving native IDs keeps the repair to
two list entries and avoids a translator or another fingerprint implementation.
