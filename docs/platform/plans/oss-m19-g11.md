# M19 G11: native account and consent stores

Status: implementation and focused proof prepared; public API read pending.
Named section refusals and separate later consent work remain explicit. Nothing is committed.

## Outcome, authority and split

The finite outcome of this candidate is native account reads, available
newsletter read/withdrawal and A129, with the accepted named section refusals.
The original G11 rows are T04-01, T04-02, A01-A04, A06-A08, A10, A119-A123,
A128 and A129. Existing implementations retain identity and behaviour. Where
native readers/writers are absent, new package code is explicitly authorized,
using managed implementations as semantic references. The earlier missing-code
stop is superseded by this class ruling. The managed rail remains unchanged.
The accepted A08/N5 limit is a named section refusal. Separate later consent
work remains explicit; no unsupported collection becomes empty success.

The worker uses the dedicated `oss-m19-g11` worktree and `codex/oss-m19-g11`
branch under the stores supervisor. Code base and fetched policy revision are
both `bb0008481a11267ec6dbe3e7e531299777cddc19`. Bounded local implementation,
review and later programme-authorized submission are in scope. The supervisor
assigns final verification and landing order. A stabilized public API read must
be answered before any commit or DCO sign-off; two independent fresh-context
reviews and canonical verification must follow before delivery.

SQL, grants and migrations belong exclusively to the SQL stream. There are no
SQL changes here. No publication, release dispatch, credentials, settings,
hosted cost, adopter source mutation or managed behaviour change is authorized.
In root server/application source only identity-preserving import rewrites are
allowed; no such files are changed. Existing constructor declarations are not
replaced with facades. Root consumer import rewrites: none.

## Before-first-touch findings

The matrix was correct at the base above:

| Rows | Native boundary at the base |
| --- | --- |
| T04-01/T04-02, A02-A04, A10, A128 | Public order-history store and summary/detail projections exist; the concrete managed store has no native counterpart. |
| A01, A06-A08 | Public `AccountReadSources` requires injected persistence; the reference runtime refuses `host_binding_required` without an opener. No complete native source exists. |
| A119 | The latest actor newsletter setter records a true preference but grants evaluator consent only on withdrawal/false; true does not establish a grant or grant sync work. |
| A120 | Existing newsletter withdrawal and denied/suppressed registration are available, not complete account-purpose commands. |
| A121-A123 | Native account preference routines expose newsletter only. Complete purpose choices and gifts/discounts grant/withdraw are absent. |
| A129 | Root `getSnapshot()` already calls the native actor routine; its packaged read boundary is missing. |

Existing operator support-read tests do not establish customer account reads.
The first stopped run changed only the task record/catalogue, ran policy and
whitespace checks, and claimed no implementation or full proof. No commit,
native session or review cycle was created by that run.

## Implementation, refusals and later owners

Package-only factories extend the existing `@openlup/platform/account-support`
entry. Existing server-factory placement avoids a new subpath, dependency, pool,
module edge, cold-consumer classification or export-map change. Simplicity
pre-check: reuse the existing assembler, projection ports and executor/gateway
rather than duplicate projection rules or introduce another orchestration layer.

`postgresAccountReadScope.ts` binds every native table read to the verified
principal/client pair and supplies owned profile identity. The new order store
reads native orders/allocated lines, settlements, shipment/tracking/status/hold
evidence and requires the invoice owner's existing companion port. IDs are
ownership-filtered before callbacks. Modern detail uses captured quote money;
legacy summaries use recorded total/currency and raw line reads retain recorded
amounts. Detail refuses `native_account_order_money_unavailable` when captured
money is absent: its required tax/shipping/discount fields cannot express absence.
No zeros, current prices or backfill replace missing historical facts. The
existing projector branches only for native summary facts; managed projections
retain their original diagnostic and money behavior.

Paid provisional activation gaps join the existing native view by client and
order, exposed by `readPaidActivationGaps(orderIds)` on both native factories as an
owned order companion keyed by order ID, with `orderId` and `paidAt`. No
subscription is invented before activation completes. The shared order DTO stays
unchanged: an attempted optional field failed its exact root compatibility
witness, so the native companion supplies the fact without altering that DTO. The subscription
activation-source constructor input is removed; subscription action states keep
native dunning/cycle evidence. Existing view privileges are tested, not changed.

`createPostgresAccountReadSources` composes available native subscription/line,
blocker, pause, method/stock-wait, alignment and action evidence. Host extension
and next-charge policy remain required. A08 and the private-profile view under
N5 have the same accepted `host_binding_required` refusal: optional explicit
saved-address, billing-profile, payment/delivery-preference and account-event
sources throw that error, with the missing section, when absent. They never
return empty success. Independent identity/native evidence reads remain usable;
the aggregate snapshot refuses if any selected section is unavailable. No new
profile tables are requested. Subscription address binding follows G3 and payment
status from method state follows G2; both are follow-ups outside this task.

The actor snapshot port covers A129 through the existing routine. Newsletter
read/withdrawal remains available; the packaged reader refuses a saved true flag
reported as granted without evaluator evidence (`host_binding_required`, section
`newsletterConsent`). No grant/true command is advertised. A119/A121-A123 complete
choices/grants remain named refusals pending a separate later consent change.
That change and its SQL forward belong to the money stream, not this worker.
Communications-purpose code changes wait until that forward exists. No consent
alias, SQL/grant/migration edit or gateway workaround is introduced here.

## Latest rulings and JSONB audit

The resumed scope accepts the A08/N5 refusals and removes the earlier profile,
historical-money and activation-association SQL proposals. The SQL-needs packet
contains only remaining ownership and any measured missing grant. Existing
customer-actor cancel-event visibility remains valid; no source column is needed.

Audit every new JSONB binding: subscription blockers and delivery alignment bind
`JSON.stringify(Object.fromEntries(nextCycles))` to `$4::jsonb`. Their ID arrays
bind `$3::uuid[]`, never JSONB. Other array arguments bind uuid[] or text[] only.
The snapshot and newsletter reader RPCs have no arguments; withdrawal binds only
boolean false to the existing boolean parameter. SQL JSON constructors and
tracking JSON operations create/read JSON inside PostgreSQL without bound arrays.
No raw JS array or possibly-array value is bound to JSONB. The real-driver proof
must exercise both map paths, actor reads/withdrawal and nonempty ID arrays.
No gateway or `postgresOperatorAuthority.ts` changes are permitted or made.

## Evidence and limitations

Focused heavy phases use the required admission gate and Node 24.21.0 /
npm 11.19.0. Dependencies and Core/Outbox builds passed earlier; the final
Platform build passes. No canonical verification has run.

- Revised package suite: 9 cases pass, including an actual TypeScript check.
- Revised native suite: 8 cases pass from isolated installed tarballs, strict
  NodeNext/Bundler consumers and a fresh qualified-v2 chain. Restricted-role
  read-only queries cover ownership, direct/companion refusal, money/tracking,
  visibility/bounds, pause/stock-wait/lock/dunning/alignment and repeated no-write
  reads. Actor snapshot/withdrawal isolation, replay/suppression and saved-flag
  refusal pass. Missing profile/event sections refuse by name. Legacy summaries
  and recorded line facts remain readable while detail refuses. Paid-activation
  companions expose only owned order identity/payment time, without a subscription.
  The existing view grant works; no remaining SQL need or array-to-JSONB defect
  was measured. Synthetic supplied profile delegates prove composition only.
- Existing order-projector suite: 34 cases pass unchanged on the final shape.
  Existing root subscription-control (3) and newsletter-preference (1) cases
  passed earlier; their source remains unchanged. The package-boundary
  suite was rerun for the ordering refresh: all 2,828 cases pass, with no new
  public subpath or dependency/module/export-map edge.
- Final strict published-tree typecheck passes all five projects with no
  unresolved edges or consumer errors. Lint passes with 33 warnings and no
  errors. Strict structural scan, whitespace and context freshness pass.

Actual platform tarball: baseline 2,102,771 compressed bytes / 9,809,502
unpacked / 2,840 files; final candidate 2,121,419 / 9,885,701 / 2,852. Delta:
+18,648 compressed bytes, +76,199 unpacked bytes, +12 files. Classified code is
1,825,970 bytes / 2,793 files; root docs are 59,148 / 6. All existing code/docs/
total pack caps pass without an increase.

Own API reports add 133 account-support lines and 37 contracts lines against
base, with no removal. The coordinator authorized exactly five candidate-induced
ordering sites in the two other API reports. Their complete before/after member
multisets are identical, with no member added or removed. No other part of those
reports is changed. The refreshed API check passes every declared subpath;
the measured pack and all existing budgets also pass.

Every new file is catalogued. Final policy/docs generation and its delta-bound
tests-owner no-impact trailer are recorded in the read packet. The policy command
remains incomplete until that trailer can be included after the API read. No
testing workflow or generated navigation changes are proposed.

## Authorized API ordering refresh and package boundary

The bounded ordering refresh changes only the following exact sites (line
numbers are at the unchanged base and remain the same after reordering):

| Report and lines | Declaration | Before → after |
| --- | --- | --- |
| `packages/platform/api/communications.api.md:389` | `defaultCommunicationPurposeRegistry` | `subscription_dunning \| transactional \| marketing_launch_offer \| marketing_newsletter \| tester_program \| admin_notification` → `marketing_newsletter \| subscription_dunning \| transactional \| marketing_launch_offer \| tester_program \| admin_notification` |
| `packages/platform/api/communications.api.md:1700, 1701` | `newsletterMarketingPurposeSchema` | `marketing_launch_offer \| marketing_newsletter` → `marketing_newsletter \| marketing_launch_offer` |
| `packages/platform/api/communications.api.md:1749, 1750` | `canonicalNewsletterWebhookEventSchema` | `marketing_launch_offer \| marketing_newsletter` → `marketing_newsletter \| marketing_launch_offer` |
| `packages/platform/api/marketing.api.md:196, 197` | `acquisitionNewsletterConsentEventSchema` | `marketing_launch_offer \| marketing_newsletter` → `marketing_newsletter \| marketing_launch_offer` |
| `packages/platform/api/marketing.api.md:211, 212` | `acquisitionNewsletterConsentResponseSchema` | `suppressed \| granted` → `granted \| suppressed` |

For each site, sorting the complete members before and after gives the identical
multiset. The default registry keeps its six original purposes; all other sites
keep exactly their original two members. This refresh does not add a purpose,
consent state or runtime behavior. Emitted JavaScript is checked separately from
the report bytes: 931 JS files were snapshotted before the refresh, aggregate
SHA256 `ac9c9e8560c8f1a64a5f02474f27f6d0c18e60e4c1ba643c906f045c2f6bdeda`.
After the focused checks and repack, all 931 emitted JS files and all 931
packed JS files match their pre-refresh byte hashes exactly (zero changed files,
same aggregate SHA256). The tarball itself is also unchanged: SHA256
`fda0eb6da7fb41b0f500ec6cfb5cdd6d5c37972a033f867bea4288141bffb693`.
The refreshed API check passes every entry; strict typecheck and lint pass with
zero errors (33 existing lint warnings).

A clean archive of `bb0008481a11267ec6dbe3e7e531299777cddc19`, built with the same
Node/npm/TypeScript toolchain, already passed the same Platform API checker
(exit 0). This is candidate-induced ordering, not a pre-existing base failure.
The checker and baseline evidence remain unchanged.

Package manifest exports are byte-identical to the base: no new public subpath.
The existing exact nested-entry inventory therefore needs no addition. The
entire `packages/platform/test/packageBoundary.test.ts`, including its shared
line 288, remains unchanged; all 2,828 cases pass in its focused rerun.
The fifteen new top-level public export names and four actor/gap method names
contain no internal module-number prefixes; they use descriptive Native,
createPostgres, readPostgres or action names. No internal-number alias is added.

## Failed attempts, regroup and handoff

Admission initially timed out at 542 seconds, then at 543 and 552 seconds for
build capacity before retries succeeded. No heavy work started outside admission.
The first native attempt failed fixture setup at the deferred order/line sum
constraint. The second passed four cases and exposed the reader's assumed
`created_at` instead of native stock-wait `opened_at`. Before a third attempt,
the task regrouped: use the owning native schema and existing transactional/
renewal fixtures, with no compatibility fallback, migration or new harness.
Order and lines now commit together; current stock-wait state is positively
exercised. The initial seven-case native proof passed; the resumed final eight-case proof
also passes. These were precommit proof
attempts; native review repair cycles remain zero.

The resumed proof also found two strict DTO-parity errors from adding an optional
field to the shared order DTO. The field was removed, preserving both unchanged
witnesses; the native order companion exposes the fact instead. Strict typecheck
now passes. No native session or repair cycle was started by these local attempts.

Next: obtain the refreshed API read answer, then commit/sign, run two fresh
independent reviews and any repairs,
and request the supervisor's final-verification slot. Separate consent work
remains with its owner; accepted section refusals are not full profile support.
There is no PR, native session, reviewer verdict, sign-off or release claim.

Self-retro: schema parity assumptions caused two failed proof attempts. Reading
the actual native owner and reusing existing fixtures removed the assumptions
without a new abstraction. Exact DTO parity also rejected a wider shared shape;
the direct native companion preserves that contract and avoids root edits.
Resource admission caused measured multi-minute
waits; batching bounded checks after admission reduced repeated setup. No
additional process change is justified.

Ordering-refresh retro: checking exact member multisets and both emitted/packed
JS identities made the mechanical scope reviewable. The existing entry avoids
a nested-entry inventory change; no additional process change is justified.
