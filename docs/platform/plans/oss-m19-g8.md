# Native lifecycle notice dispatch

Status: READY_FOR_REVIEW. Local implementation, accepted maintainer read and
focused proof are complete. Forward admission, the authorized real destination-
writer join at main integration, native review and lead-selected verification
remain pending. No publication or live-provider qualification is claimed.

## Outcome, scope and authority

Native paid-mail, lifecycle, dunning and reminder sources on qualified-v2
reach captured dispatch through the actual public
bindings and restricted PostgreSQL runtime login. Replay sends no second notice;
competing workers and stale finalizers are fenced. Failed delivery preserves
payment, case and subscription state. Explicit notice-storage contention rolls
back cleanly and the identical request succeeds once after release. Exhaustion
keeps an open repair case and an active subscription.

Worktree: .claude/worktrees/oss-m19-g8; branch: codex/oss-m19-g8.
Code base and current instruction revision are
bb0008481a11267ec6dbe3e7e531299777cddc19; origin/main was refreshed before this
handoff and is identical. The notice writer acts under the money-stream
supervisor. Current authority permits local implementation, focused proof and DCO-signed
commit after the accepted read corrections and checks. Native review, submission
and external delivery remain unauthorized at this stop. Canonical
verify requires the lead's selection. Release, publication, provider activation,
credentials, hosted costs and adopter changes remain outside this row.

The maintainer accepted the staged read at tree
b2bd59ab7c95e098bfb3208088ad4853cb6fb66b and diff SHA-256
6397ccbaf4b267405c867c4228cb8f1d8e3e9f85ff26ae64591e98a2777766e3.
The only follow-up scope is a lost-mail diagnostic query and native witness,
removing the contributor-guide paragraph in favor of a scoped no-impact trailer,
public terminology cleanup and the explicit customer-data erasure limitation.
The eight grants and the four-table capture/restore set were accepted unchanged.

The smallest complete scope is one native notice binding, its adjacent export
line and API declarations; one native forward and selected manifests; focused
real-driver tests; additive connected-transfer table entries; and owner docs.
The paid handler, lifecycle template mapper and protected dunning source
routines remain unchanged. There is no facade, additional notification ledger,
dunning outbox producer, provider dependency, scheduler, HTTP route or table
grant. Rendering, locale, access links and host scheduling stay with the host.
The transactional delivery engine and receipt reader enter through structural
ports, preserving the subscription module's import boundary.

## Firm SQL inventory and settlement isolation

Forward: [20261101231000_native_paid_email.sql](../../../db/platform/migrations/20261101231000_native_paid_email.sql).
Replace only public.commerce_order_emit_paid_notification() returning trigger.
Header attributes, invoker rights, search path, ownership and ACL stay intact.
No function, table, index, trigger or constraint is created; no other function
body changes. The existing commerce.order.paid event is unchanged. A separate
commerce.order.paid.email event carries truthful order_<UUID>, occurredAt and
native mode from the linked subscription cycle or draft metadata, matching the
managed emitter's mail-event contract without editing the handler.

The added insert runs inside settlement. It has its own idempotency key,
ON CONFLICT DO NOTHING, and an exception subtransaction with 100-ms lock_timeout.
It catches insertion errors and query cancellation and restores the caller's
timeout. Real native settlement tests inject mail-only P0001, 57014 and lock
contention: paid truth and the original paid event commit. A lost mail event
leaves that event/order for operator repair; this is best-effort capture, not a
new durable mail obligation. The original paid event's existing coupling is
unchanged. A paid replay emits no second mail event.

EXECUTE to service_role is added on exactly eight existing signatures:

- public.subscription_dunning_claim_batch(integer,integer,integer)
- public.subscription_dunning_mark_sent(uuid,uuid,text)
- public.subscription_dunning_mark_result(uuid,uuid,text,text,timestamptz)
- public.dunning_lifecycle_recipient(uuid)
- public.communications_notification_control_enabled(text[])
- public.communications_recipient_consent_state(text,text[])
- public.dunning_lifecycle_renewal_reminder_enqueue(integer)
- public.dunning_lifecycle_pause_reminder_dispatch(integer)

All eight were approved together. The forward contains one conditional DO for
service_role and GRANT, the exact role-existence condition and one constant
EXECUTE string, with no other branch or operation. Existing PUBLIC/browser
revocations are retained. No additional grant, revoke, definer or RLS change.
The shared SQL inventory reserves this exact function replacement and grant-only
list; no overlap with another row was found.

### Grant exposure assessment

These are invoker routines under the installed trusted-runtime model. SQL does
not authenticate an end user or enforce a job identity. The binding is unmounted
and scheduled-host-only, takes only a bounded limit, derives IDs from durable
sources, and exposes no recipient lookup or producer route to a browser. Browser
roles retain no EXECUTE. A compromised runtime credential can bypass the binding;
the following exposures are not hidden by its interface.

- claim_batch: needed to lease existing notices; exposes queued customer references/payload and mutates claim counters/tokens; a runtime holder can claim or starve work, while SQL tokens fence later finalization.
- mark_sent: needed to acknowledge accepted capture; exposes a boolean and changes a sending notice; a holder with the current token can falsely acknowledge it, so trusted host evidence remains required.
- mark_result: needed for failed/skipped delivery; exposes a boolean and changes sending/retry status; a holder with the current token can suppress or reschedule work; stale tokens refuse.
- recipient: needed to reuse native recipient projection; exposes email, first name and country for any supplied client UUID with no ownership check; runtime already has client SELECT, and only the trusted binding derives client IDs from sources. It must never become a browser lookup endpoint.
- notification_control_enabled: needed to honor native send controls; exposes only a boolean for supplied keys and does not write; a holder can probe controls or ignore the result, so delivery composition remains trusted.
- recipient_consent_state: needed to honor native recipient refusal; exposes unknown/refused for supplied fingerprint/purposes and does not write; a holder can probe hashed-recipient state or ignore refusal, so no browser-facing raw RPC is supplied.
- renewal_reminder_enqueue: needed by the scheduled reminder phase; mutates the existing ledger for active future renewals and returns a count; SQL is replay-safe but has no caller/job admission or upper batch cap, so direct runtime misuse can bulk-enqueue. The binding bounds 1–100 and the host owns schedule authorization.
- pause_reminder_dispatch: needed by the scheduled pause-reminder phase; mutates only reminder ledger rows for existing pause windows and returns counts, never pauses service; it likewise lacks caller/job admission and an upper SQL batch cap, so runtime misuse can enqueue prematurely or in bulk. The host schedules and bounds the binding.

The existing producers select eligible future renewal/pause dates without a
courtesy-window cutoff; the binding preserves that selection and adds no timing
policy. The producers do belong to scheduled jobs. This installed profile uses the same
trusted runtime login for those jobs and has no narrower scheduled-job role.
Keeping them in the explicit scheduled binding does not require or authorize a
new role or browser route. Avoiding them would duplicate their existing ledger
writers or change that role model; neither is proposed. The maintainer read must
accept these explicit trusted-runtime exposures.

## SQL risk assessment and managed compatibility

Assessment against the programme's module SQL defect classes:

- Fiscal documents and dispatched payment attempts: no writer or state added.
- Reclaim and terminal states: native claim ceilings and token finalizers remain;
  event/reminder selection stops after six recorded failed receipts. Failed or
  exhausted work remains visible for host repair; it never pauses service.
- Stuck obligations: source rows and delivery receipts survive failure. Accepted
  receipt recovery completes a lost acknowledgement without another send.
  Best-effort paid-mail capture retains the paid event as repair evidence.
- Freeze/snapshot races: no money/parcel snapshot or freeze path changes; notice
  transport runs with an exclusive autocommit session, outside a transaction.
  Connected capture/restore retains the four existing notice/receipt tables.
- Replay: existing source uniqueness, stable message keys, transactional delivery receipts and
  session advisory locks prevent sequential or competing captured sends.
- Stale tokens: actual lease expiry/takeover refuses both old-token finalizers;
  the binding checks the live claim before transport and honors finalizer refusal.
- Definer/grant/RLS exposure: invoker headers and existing row policies remain;
  the eight explicit exposures above require a trusted scheduled-job host.
  Real anon/authenticated calls refuse all eight; runtime DDL is refused.
- Coupling: failed captured transport changes notice/receipt work only. The new
  paid insert is bounded and isolated from settlement. Native case/notice storage
  remains atomic: an explicit SHARE lock plus the caller's 150-ms lock_timeout
  produces transient 55P03, full rollback and no partial case/rung. Releasing the
  lock permits the identical request once with one notice. This known property
  is intentional; the protected dunning routines remain unchanged.

Managed inspection used both this checkout's managed migrations and the
adopter's origin/main migrations/server/src. The native paid emitter and five
recipient/policy/producer helpers have no managed migration definition. Managed
claim naming overlaps; managed finalizer token signatures differ. Only native
SQL selections change, and none of those eight bodies change. No managed
migration, paid handler, managed binding or adopter source changes.

## Executed proof and documentation

[The focused suite](../../../tests/postgres/m19NoticeIsolation.test.ts) installs
all 96 selected qualified units through the real migration runner, including
this forward. Status has no pending units and repeated apply is empty. Actual
g8_runtime has no superuser, database/role creation, replication or RLS-bypass
privilege. Every dispatch operation uses that login and the real pg driver;
no scripted pool or live communications provider is used.

Catalog/prices and isolated baseline client/subscription/cycle facts are
synthetic fixture setup. Drafts, settlement and trigger payloads, activation,
lifecycle events, cases, notifications and reminders use their native writers;
no notice, event, reminder or outbox payload is fabricated. Fault-plant triggers
exist only in the disposable test database and are removed. Policy text-array
parameters use actual PostgreSQL text[], with no array bound to jsonb. The test
supplies the activation/dunning functions directly while the separate retry
binding promotion is pending; it does not claim a whole renewal-driver journey.

The focused cases cover paid trigger -> existing handler -> transactional delivery capture and
receipts; sequential replay; mail-only SQL errors/cancellation/bounded contention;
activation and customer lifecycle events; both native reminder producers; dunning
claims; competing event and dunning workers; actual stale takeover; lost-ack
receipt recovery; failed delivery preserving real order/intent/case/subscription
rows; open-case exhaustion with active service; controls/consent refusal; all
eight browser EXECUTE refusals; and native notice/receipt capture/restore.

The transfer profile adds only existing subscription_dunning_cases,
subscription_dunning_notifications, subscription_reminder_ledger and
transactional_delivery_receipts. Cases precede notifications in restore order.
The transfer witness compares exact rows and replays the restore, before any
unrelated checkout-draft facts enter its source. These root-only entries add no
package bytes. Their finite-profile owner read is included in the API/grant packet.
Whole-journey transfer qualification remains the final journey writer's work.

[The explicit catalog measurement](../../../tests/postgres/m19NoticeCatalog.proof.ts)
reads the pre-feature review-base manifest, refuses an already-included forward,
checks each old digest, then applies the same forward and measures all five
shapes: legacy (role absent), qualified bootstrap/separate migrator, and restricted
installer/operator-managed roles. The selected source plans now contain
92/96/95 units. The generator originally read HEAD; its final correction reads
the review base so a later commit does not change the measurement input. At
this handoff both resolve to the exact same commit and manifest bytes; all five
executed measurements retain identical inputs. These are local real-catalog
measurements, not class admission.

Current focused validation: 14 PostgreSQL cases pass in 14.22 s (12.77 s test
bodies), including the owner query against planted mail-only failures and
healthy/unpaid controls in a restricted-runtime read-only transaction. Final strict typecheck passes with zero unresolved edges and zero
consumer errors; API declarations match; ast-grep and whitespace checks pass.
Documentation policy accepts all five obligations with none unanswered. The
contributor guide is unchanged; its scoped tests no-impact explanation is in a
signed documentation record preceding the feature commit, using the documented
trailer workflow. No policy workaround or control edit is introduced.
Owned pools and containers are removed. Final npm run lint passes, including
core/outbox/platform builds and eight structural rule suites: zero errors and
33 existing warnings outside this change. Real pack measurements follow below.

Owner sections updated with the code: subscription contracts and existing-store
transfer; compatibility lifecycle/posture; native retained-store adapter guidance;
and the scoped test-guidance no-impact explanation in the commit trailer. The API snapshot adds only this binding's
export and declarations. Generated AGENT_CONTEXT changes only the line offsets
of an unchanged data/migration excerpt. No unrelated package API line changes.

## Real package measurement

Pre-read npm pack --ignore-scripts tarballs on Node 24.21.0/npm 11.19.0:

| Artifact | Packed bytes | Files | Delta from baseline |
| --- | ---: | ---: | --- |
| Reconstructed unchanged package | 2,102,771 | 2,840 | baseline |
| Current candidate | 2,107,183 | 2,843 | +4,412 B / +3 files |
| Candidate with this SQL file packaged | 2,107,824 | 2,844 | +5,053 B / +4 files |

The baseline restores the existing index exports and generated context to the
pre-feature review base
and excludes only the new binding's source/JS/declaration files. Its npm integrity
matches the earlier unchanged-package measurement. The SQL projection adds the
exact 2,546-byte canonical forward to a scratch copy; the extra 641 packed bytes
are measured in a real tarball, not estimated from source length. It does not
include the foundation writer's eventual generated migration metadata or whole
stream integration. Both figures supersede the earlier +4,358/+5,010 measurements.
The about-3-KB soft target is exceeded and was reported immediately. No numeric
cap or publishing control changes. The two root transfer entries add zero bytes
to the package file set. These pre-read figures precede the neutral declaration-comment edits; the
signed candidate is re-packed with this SQL file at handoff. No provider dependency
is added.

## Delivery boundary, history and estimate

Forward-class admission still refuses the draft under the unchanged registry:
non-expand-only forward differs from reviewed replacement path or bytes.
No registry pin or checker edit is made. Canonical SQL packaging and migration
projection remain pending integration of the foundation predecessor, now landed
on main at 09cd599bfef6bff74f4431b0cf7a00ebf80f1e6a; neither
packages/platform/sql nor src/migrations changes here. DCO-signed commit is authorized after the accepted corrections; no native
review, canonical verify, pull request or release is authorized at this stop.

History retained: the original isolation criterion was corrected by the
supervisor to atomic contention rollback/retry. The first permission probe found
three missing EXECUTEs; its complete-path rerun found five more together, all now
approved. An initial action-name mistake (slide) was fixed to slide_next_cycle.
A generator union typing error was fixed. Lint rejected direct communication
module imports; host-composed delivery/receipt ports preserve the module boundary.
The final transfer checklist found the four missing table entries and added a
specific retained-row witness. No native review or repair cycle was consumed.

Remaining active work: 1–2 working days for integration, native review and
lead-selected verification, including ordinary repairs. Implementation and the
maintainer read are complete. Queue/control waiting time is external elapsed
time rather than implementation work; the earlier 4–6-day figure was total effort.
The about-3-KB packed target is exceeded; no cap increase is requested. The
existing subscriptions/index.ts entry and its closed test inventory already
cover this export; no new subpath, package export wiring or inventory row is needed.

OMS: no supersededByStableJourneyKey, checkoutAbandoned or new location for a
dispatched payment attempt is written. Native repair cycles used: 0. No WIP ref was created. The signed candidate and its diff are scanned with
gitleaks before handoff.

Self-retro: final pack admission waited 445 s; the PostgreSQL suite itself took
14.22 s after the accepted repair-query additions. Permission completeness must include both producer calls and retained
transfer rows before declaring a native dispatch path complete. Reusing existing
ledgers and host-composed transactional delivery ports kept the production change to one binding;
real PostgreSQL exposed permissions and isolation facts that scripted pools
would miss. The accepted explicit-lock diagnostic remains as a retry witness. The read
correction makes lost mail capture observable through one owner-documented
read query, and states that customer-linked notice/receipt facts have no erasure
path yet; no SQL or delivery behavior changes.


## Existing-suite compatibility audit

The signed candidate reached the existing-suite stop finding below; the audit
is blocked and incomplete. Existing
suite bodies remain unchanged; the sole authorized exception increments the
current native chain literals and current inventory pins by this forward. Frozen
issued-prefix inventory pins and unit counts remain untouched. No changelog edit
exists, so there is no note to move to a fragment.

The fresh real PostgreSQL measurement rechecked each previous digest before
applying the byte-identical forward and observed:

| Installation shape | Current measured inventory SHA-256 |
| --- | --- |
| Legacy | 55fda620a186c372c82d35de83888bfb133d0333734334d96a5737af3bcc5113 |
| Qualified bootstrap | 3280c765be6ae0af73e826207c07bce0dfae98cee9604e90503f659c621d7a4d |
| Qualified separate migrator | f230b54b465126402a2ba7a22793e70b80b0bea3da6ca5d1c10502224dffce7b |
| Restricted installer-managed | b533e764e09628871a0d1d3709890aa5fde4bb50cb8126ec630ee7e41e839801 |
| Restricted operator-provisioned | 85d9c6c48bb800d00d91d99869d6a1271cb47af8022f96c3cd786c1e5aa80ace |

Current qualified literals change 95 to 96; restricted literals change 94 to 95,
in their existing tests/proof companions only. No historic inventory or SQL
bytes change. The suite list and results are recorded at the end of this audit.

Rows need not come from the new draft writer: any later native paid transition
attempts the additional mail capture, with a linked cycle selecting subscription_cycle
and absent draft metadata falling back to one_time. Already-paid imported rows
are not backfilled, and restore inserts do not fire the paid UPDATE trigger.
The opt-in notice job also scans older unreceipted native lifecycle/reminder
facts; enabling it can process a backlog. Existing sent dunning rows are not
claimed again, and accepted matching receipt keys prevent duplicate sends.
A missing historical receipt is not proof of a prior send. No created-after
cutoff or alternate-rail receipt-key translation is introduced. The host must
account for the source backlog and receipt identities when enabling this job.
No subscription, method or renewal routine body is changed by this row, and
no new-writer companion row is required to continue renewing an existing store.

The two dunning-case/notification transfer entries will be supplied by the
scheduled retry predecessor, which lands first. This standalone candidate keeps
them until integration; at its merge it drops only those duplicate entries and
retains the reminder ledger and transactional delivery receipt entries. The
accepted read packet records the explicit ownership handoff.


### Existing-suite stop finding

The unchanged opt-in connected-handover witness failed before creating any
source/target/cohort resources. Node v24.21.0 and the already-local immutable
Node24.21.0 image were confirmed. The default invocation requires the old
separate-migrator inventory at runM14EffectHandover.ts:53; the selected branch
manifest now has the independently measured new inventory. This is a consequence
of the candidate's added forward, not a changed test input or patched witness.
The witness's next frozen graph guard also requires 82 tables; the added four
transfer entries make the actual graph 86. That guard and all subsequent
handover/recovery assertions were not reached. Neither assertion is among the
specifically authorized literal-count exceptions, and neither was changed.

Actual current inventory:
f230b54b465126402a2ba7a22793e70b80b0bea3da6ca5d1c10502224dffce7b.
Unchanged witness expectation:
894164222f03e296ebdb05b18c9065ad1a53bd2ec27e53f28c46812fb5267af3.

The existing-suite requirement is not satisfied. No conclusion about the
unreached handover behavior is drawn from the new focused proof or the earlier
maintainer read. The audit queue stopped at its admission wait after this
failure; no active suite was interrupted and no source/SQL repair was made.
The known count/current-inventory corrections remain the only test edits.
A decision is needed on the fixed witness/profile boundary before further work;
the witness must not be relabeled green by silently changing its assertions.

At the first audit stop, 60 suites passed (3598 cases), the unchanged handover preflight failed, and 64 suites were unrun. The table below now records the cumulative execution inventory, distinguishing the earlier pre-R0 results from the resumed R0-base results. The subsequent handover and released-upgrade findings are recorded in their continuation sections. Four selected proof companions are tracked with their owning suites.

| Existing suite / witness | Result |
| --- | --- |
| `packages/platform/test/account-support/bindings.test.ts` | PASS before R0 merge — Tests  5 passed (5) |
| `packages/platform/test/account-support/operatorAuthority.test.ts` | PASS before R0 merge — Tests  5 passed (5) |
| `packages/platform/test/account-support/ownerRefusals.test.ts` | PASS before R0 merge — Tests  27 passed (27) |
| `packages/platform/test/account-support/paymentMethodComposition.test.ts` | PASS before R0 merge — Tests  16 passed (16) |
| `packages/platform/test/account-support/portFit.test.ts` | PASS before R0 merge — Tests  1 passed (1) |
| `packages/platform/test/account-support/selfService.test.ts` | PASS before R0 merge — Tests  8 passed (8) |
| `packages/platform/test/commerce/effects/commerceDomainEffects.test.ts` | PASS before R0 merge — Tests  5 passed (5) |
| `packages/platform/test/commerce/managedOutboxEvents.test.ts` | PASS before R0 merge — Tests  2 passed (2) |
| `packages/platform/test/communications/sql.test.ts` | PASS on R0 base before address repair — Tests  1 passed (1) |
| `packages/platform/test/composition/commerceContribution.test.ts` | PASS before R0 merge — Tests  5 passed (5) |
| `packages/platform/test/fulfillment/paidHandoff.test.ts` | PASS before R0 merge — Tests  2 passed (2) |
| `packages/platform/test/identity/sql.test.ts` | PASS on R0 base before address repair — Tests  1 passed (1) |
| `packages/platform/test/packageBoundary.test.ts` | PASS before R0 merge — Tests  2819 passed (2819) |
| `packages/platform/test/risk/orderPaidRiskPort.test.ts` | PASS before R0 merge — Tests  8 passed (8) |
| `packages/platform/test/subscriptions/contracts.test.ts` | PASS before R0 merge — Tests  3 passed (3) |
| `packages/platform/test/subscriptions/facades.test.ts` | PASS before R0 merge — Tests  43 passed (43) |
| `packages/platform/test/subscriptions/portFit.test.ts` | PASS before R0 merge — Tests  12 passed (12) |
| `packages/platform/test/subscriptions/renewalCycleMechanism.test.ts` | PASS before R0 merge — Tests  29 passed (29) |
| `packages/platform/test/subscriptions/renewalKeys.test.ts` | PASS before R0 merge — Tests  1 passed (1) |
| `scripts/agent-review-queue.test.ts` | PASS on R0 base before address repair — Tests  189 passed (189) |
| `scripts/check-publishable-gap-enumeration.test.ts` | PASS on R0 base before address repair — Tests  5 passed (5) |
| `scripts/checkout-recovery-lifecycle-schema.test.ts` | PASS before R0 merge — Tests  9 passed (9) |
| `scripts/customer-diagnostic-history-schema.test.ts` | PASS on R0 base before address repair — Tests  16 passed (16) |
| `scripts/customer-recovery-console-managed-schema.test.ts` | PASS before R0 merge — Tests  9 passed (9) |
| `scripts/customer-recovery-console-schema.test.ts` | PASS before R0 merge — Tests  12 passed (12) |
| `scripts/customer-selfservice-recovery-schema.test.ts` | PASS before R0 merge — Tests  3 passed (3) |
| `scripts/documentation-bundle.test.ts` | PASS on R0 base before address repair — Tests  20 passed (20) |
| `scripts/documentation-cli.test.ts` | PASS on R0 base before address repair — Tests  3 passed (3) |
| `scripts/documentation-impact.test.ts` | PASS before R0 merge — Tests  101 passed (101) |
| Fulfillment provider lifecycle-evidence suite | PASS before R0 merge — Tests  28 passed (28) |
| `scripts/oss-published-tree-check.test.ts` | PASS on R0 base before address repair — Tests  74 passed (74) |
| `scripts/packages/package-release.test.ts` | PASS on R0 base before address repair — Tests  18 passed (18) |
| `scripts/packages/platform-cold-consumer.test.ts` | PASS before R0 merge — Tests  108 passed (108) |
| `scripts/packages/set-release.test.ts` | PASS on R0 base before address repair — Tests  68 passed (68) |
| `scripts/payment-truth-schema.test.ts` | PASS before R0 merge — Tests  3 passed (3) |
| `scripts/platform-migration-manifest.test.ts` | PASS on R0 base before address repair — Tests  19 passed (19) |
| `scripts/public-ci-neutrality.test.ts` | PASS on R0 base before address repair — Tests  60 passed (60) |
| `scripts/qualified-migration-admission.test.ts` | PASS on R0 base before address repair — Tests  24 passed (24) |
| `scripts/reviewed-batch-forward.test.ts` | PASS on R0 base before address repair — Tests  691 passed (691) |
| `scripts/source-preview-release.test.ts` | PASS on R0 base before address repair — Tests  718 passed (718) |
| `scripts/source-release-preparation.test.ts` | PASS on R0 base before address repair — Tests  7 passed (7) |
| Fulfillment provider commerce-port suite | PASS before R0 merge — Tests  6 passed (6) |
| `server/adapters/postgres/migrationRunner.test.ts` | PASS on R0 base before address repair — Tests  10 passed (10) |
| `server/adapters/supabase/catalogRead.test.ts` | PASS on R0 base before address repair — Tests  21 passed (21) |
| `server/adapters/supabase/commerce/oms/outboxEvents.test.ts` | PASS before R0 merge — Tests  2 passed (2) |
| `server/adapters/supabase/commerce/outboxAggregateStore.test.ts` | PASS before R0 merge — Tests  2 passed (2) |
| `server/adapters/supabase/customerSubscriptionFacade.test.ts` | PASS before R0 merge — Tests  7 passed (7) |
| `server/adapters/supabase/paidFulfillmentRecoveryOpsPort.test.ts` | PASS before R0 merge — Tests  4 passed (4) |
| `server/adapters/supabase/platform/dunningObservabilityEvidence.test.ts` | PASS before R0 merge — Tests  9 passed (9) |
| `server/adapters/supabase/platform/observabilityEvidencePort.test.ts` | PASS before R0 merge — Tests  9 passed (9) |
| `server/adapters/supabase/subscription/dunningStore.test.ts` | PASS before R0 merge — Tests  6 passed (6) |
| `server/adapters/supabase/subscription/recoveredDunningCaseScan.test.ts` | PASS before R0 merge — Tests  7 passed (7) |
| `server/domains/commerce/omsFulfillmentHealthDigest.test.ts` | PASS before R0 merge — Tests  3 passed (3) |
| `server/domains/commerce/outboxDispatchRegistry.test.ts` | PASS before R0 merge — Tests  39 passed (39) |
| `server/domains/commerce/outboxOrderPaidEmailHandler.test.ts` | PASS before R0 merge — Tests  23 passed (23) |
| `server/domains/commerce/paidFulfillmentRecovery.test.ts` | PASS before R0 merge — Tests  14 passed (14) |
| `server/domains/commerce/paidFulfillmentRecoveryOpsHandler.test.ts` | PASS before R0 merge — Tests  9 passed (9) |
| `server/domains/platform/emailObservabilityEvidence.test.ts` | PASS before R0 merge — Tests  12 passed (12) |
| `server/domains/platform/omnipackFulfillmentHealthObservability.test.ts` | PASS before R0 merge — Tests  5 passed (5) |
| `server/domains/platform/outboxObservabilityEvidence.test.ts` | PASS before R0 merge — Tests  1 passed (1) |
| `server/domains/platform/subscriptionObservabilityEvidence.test.ts` | PASS before R0 merge — Tests  13 passed (13) |
| `server/domains/platform/subscriptionRenewalTriageContext.test.ts` | PASS before R0 merge — Tests  5 passed (5) |
| `server/runtime/auth/identityReadiness.test.ts` | PASS on R0 base before address repair — Tests  40 passed (40) |
| `server/runtime/communications/communicationsSchema.test.ts` | PASS before R0 merge — Tests  1 passed (1) |
| `server/runtime/public-reference/m11CommerceBinding.test.ts` | PASS before R0 merge — Tests  15 passed (15) |
| `server/runtime/public-reference/m12AccountSupportBinding.test.ts` | PASS before R0 merge — Tests  17 passed (17) |
| `server/runtime/public-reference/m12SelfServiceBinding.test.ts` | PASS before R0 merge — Tests  15 passed (15) |
| `server/runtime/public-reference/m15RiskBinding.test.ts` | PASS before R0 merge — Tests  8 passed (8) |
| `server/runtime/public-reference/subscriptionFacades.test.ts` | PASS on R0 base before address repair — Tests  2 passed (2) |
| `tests/platform/channels/channelConsumer.test.ts` | PASS on R0 base before address repair — Tests  2 passed (2) |
| `tests/platform/inventory/inventoryConsumer.test.ts` | PASS on R0 base before address repair — Tests  2 passed (2) |
| `tests/postgres/accountSupportComposition.test.ts` | PASS on R0 base before address repair — Tests  2 passed (2) |
| `tests/postgres/accountSupportOperatorAuthority.test.ts` | PASS on R0 base before address repair — Tests  23 passed (23) |
| `tests/postgres/accountSupportSelfService.test.ts` | PASS on R0 base before address repair — Tests  3 passed (3) |
| `tests/postgres/accountSupportUpgrade.test.ts` | PASS on R0 base before address repair — Tests  2 passed (2) |
| `tests/postgres/acquisitionEvidenceParity.test.ts` | PASS on R0 base before address repair — Tests  11 passed (11) |
| `tests/postgres/bundleNative.test.ts` | PASS on R0 base before address repair — Tests  5 passed (5) |
| `tests/postgres/channelConnectedRestore.test.ts` | PASS on R0 base before address repair — Tests  1 passed (1) |
| `tests/postgres/channelPurchase.conformance.test.ts` | PASS on R0 base before address repair — Tests  30 passed (30) |
| `tests/postgres/commerceComposition.test.ts` | PASS before R0 merge — Tests  4 passed (4) |
| `tests/postgres/commerceManagedRail.test.ts` | PASS on R0 base before address repair — Tests  26 passed (26) |
| `tests/postgres/communicationsNative.test.ts` | PASS before R0 merge — Tests  20 passed (20) |
| `tests/postgres/connectedManagedRetained.test.ts` | PASS before R0 merge — Tests  16 passed (16) |
| `tests/postgres/connectedStoreTransfer.test.ts` | PASS before R0 merge — Tests  7 passed (7) |
| `tests/postgres/customerNewsletterWithdrawal.test.ts` | PASS on R0 base before address repair — Tests  8 passed (8) |
| `tests/postgres/dunningAttemptReplay.test.ts` | PASS on R0 base before address repair — Tests  20 passed (20) |
| `tests/postgres/dunningLifecycleActiveRepair.test.ts` | PASS before R0 merge — Tests  10 passed (10) |
| `tests/postgres/fulfillmentDeliveryAlignment.test.ts` | PASS on R0 base before address repair — Tests  29 passed (29) |
| `tests/postgres/fulfillmentHostSeamRefusals.test.ts` | PASS on R0 base before address repair — Tests  1 passed (1) |
| `tests/postgres/fulfillmentNativeConformance.test.ts` | PASS on R0 base before address repair — Tests  4 passed (4) |
| `tests/postgres/fulfillmentPreparationBinding.test.ts` | PASS on R0 base before address repair — Tests  2 passed (2) |
| `tests/postgres/fulfillmentRenewalAdmission.test.ts` | PASS on R0 base before address repair — Tests  9 passed (9) |
| `tests/postgres/fulfillmentStockEvidenceReplay.test.ts` | PASS on R0 base before address repair — Tests  6 passed (6) |
| `tests/postgres/inventoryNative.test.ts` | PASS on R0 base before address repair — Tests  8 passed (8) |
| `tests/postgres/invoicingContinuity.test.ts` | PASS on R0 base before address repair — Tests  3 passed (3) |
| `tests/postgres/invoicingDelivery.test.ts` | PASS on R0 base before address repair — Tests  18 passed (18) |
| `tests/postgres/invoicingManagedCorrection.test.ts` | PASS on R0 base before address repair — Tests  26 passed (26) |
| `tests/postgres/invoicingNativeConformance.test.ts` | PASS on R0 base before address repair — Tests  9 passed (9) |
| `tests/postgres/invoicingStoreContract.test.ts` | PASS on R0 base before address repair — Tests  87 passed (87) |
| `tests/postgres/m05CatalogComposition.test.ts` | PASS on R0 base before address repair — Tests  3 passed (3) |
| `tests/postgres/m14ManagedCatchup.test.ts` | PASS on R0 base before address repair — Tests  1 passed (1) |
| `tests/postgres/m14QualifiedAdminComposition.proof.ts` | Covered by passing parent |
| `tests/postgres/m14QualifiedAdminComposition.test.ts` | PASS before R0 merge — Tests  2 passed (2) |
| `tests/postgres/m14QualifiedComposition.proof.ts` | Covered by passing parent |
| `tests/postgres/m14QualifiedComposition.test.ts` | PASS before R0 merge — Tests  4 passed (4) |
| `tests/postgres/m14ReleasedSchemaUpgrade.proof.ts` | Parent not run after stop |
| `tests/postgres/m14ReleasedSchemaUpgrade.test.ts` | PASS on R0 base after address repair — Tests  1 passed (1) |
| `tests/postgres/m14RestrictedConnectedRestore.test.ts` | PASS before R0 merge — Tests  15 passed (15) |
| `tests/postgres/managedStorageTransfer.proof.ts` | Parent not run after stop |
| `tests/postgres/managedStorageTransfer.test.ts` | PASS on R0 base after address repair — Tests  1 passed (1) |
| `tests/postgres/newPurchaseStockManaged.test.ts` | PASS on R0 base after address repair — Tests  10 passed (10) |
| `tests/postgres/operatorIdentityUpgrade.test.ts` | PASS on R0 base after address repair — Tests  17 passed (17) |
| `tests/postgres/operatorInvitationCatalogue.test.ts` | PASS on R0 base after address repair — Tests  3 passed (3) |
| `tests/postgres/operatorInvitationLifecycle.test.ts` | PASS on R0 base after address repair — Tests  3 passed (3) |
| `tests/postgres/partnerAcquisition.test.ts` | PASS on R0 base after address repair — Tests  10 passed (10) |
| `tests/postgres/paymentsNativeConformance.test.ts` | PASS before R0 merge — Tests  7 passed (7) |
| `tests/postgres/platformManifestSuffix.test.ts` | PASS on R0 base after address repair — Tests  4 passed (4) |
| `tests/postgres/portabilityRows.test.ts` | PASS on R0 base after address repair — Tests  2 passed (2) |
| `tests/postgres/promotionsNative.test.ts` | PASS on R0 base after address repair — Tests  5 passed (5) |
| `tests/postgres/retainedClientSubscriptionImport.test.ts` | PASS before R0 merge — Tests  13 passed (13) |
| `tests/postgres/reviewedBatchForwards.test.ts` | PASS on R0 base after address repair — Tests  106 passed (106) |
| `tests/postgres/reviewedPortableCreation.test.ts` | PASS on R0 base after address repair — Tests  20 passed (20) |
| `tests/postgres/runM14EffectHandover.ts` | PASS on R0 base — actual handover completed; measured pins, original guard message |
| `tests/postgres/shippingNative.test.ts` | PASS on R0 base after address repair — Tests  6 passed (6) |
| `tests/postgres/starterGraduationCadence.test.ts` | PASS on R0 base after address repair — Tests  14 passed (14) |
| `tests/postgres/subscriptionComposition.test.ts` | PASS on R0 base after address repair — Tests  20 passed (20) |
| `tests/postgres/subscriptionContinuityBaseline.test.ts` | PASS before R0 merge — Tests  4 passed (4) |
| `tests/postgres/subscriptionManagedStock.test.ts` | PASS on R0 base after address repair — Tests  12 passed (12) |
| `tests/postgres/subscriptionRenewalLifecycle.test.ts` | PASS on R0 base after address repair — Tests  66 passed (66) |


Audit self-retro: the regular transfer and new notice suites did not execute the
opt-in handover entry. Tracing direct executable importers exposed its fixed
inventory/profile contract before broad readiness could be claimed. Keep that
failure distinct from the specifically authorized chain-count corrections and
from unreached provider/handover behavior; no assertion was relaxed to pass it.


The latest grant permits a DCO commit of only the five authorized count/pin test
updates and this task evidence. That local commit does not resolve or waive the
failed witness or qualify this candidate for native review. No source/SQL fix,
unchanged-witness edit, registry pin or checker change is included. The two
dunning transfer entries are deliberately kept until the instructed merge;
removing them early is not used to satisfy the old graph guard.

Count-update author checks passed: strict typecheck has zero unresolved edges
and zero consumer errors; lint/build and eight structural rule suites have zero
errors and the same 33 pre-existing warnings. Whitespace, generated context and
the staged-diff secret scan pass. These checks do not resolve the failed
handover witness or replace the 64 unrun existing suites.


## R0 integration and handover-pin continuation

The supervisor authorized the two handover preflight literals as an extension
of the chain-count exception: preserve fixed expectations, measure them on real
PostgreSQL, and run the witness through its actual handover assertions. Only its
inventory literal, connected-table-count literal and explanatory guard message
may change. An existing-suite failure requiring source or SQL repair remains a
stop for a delta read.

The expressly requested merge of origin/main at
09cd599bfef6bff74f4431b0cf7a00ebf80f1e6a is merge commit
0c7090a36def3fcd415d4f6dc120363e5a5f55be. The publication catalogue and migration
owner document required additive resolutions; both sides' entries and text are
preserved. This is a manual integration, not a claimed mechanical carry-over.
No native review has started; its repair-cycle count remains zero. The policy
revision is the same fetched main commit, separately from the earlier bb000848
feature review base.

The canonical package-projection generator now copies the forward into
packages/platform/sql and incorporates its canonical selections, inventories and
SHA in sql/manifest.json. The new packaged SQL has the same full SHA-256 as the
issued source: 92eca6c6d7cc9024bdd4260fca3059a2a47e05f3b4296e561dbd16f642cc5971.
This supersedes the earlier packaging-pending status, without changing SQL bytes
or the closed SQL-object inventory. The merged build and API report check pass.
The 64 remaining suites are byte-identical to this merged main; their pending
results are kept separate from the 60 passes measured before integration.

Fresh real-PostgreSQL installations after the R0 merge reproduced all five
current inventory fingerprints below, checking each issued pre-forward pin
before applying the byte-identical forward. The regenerated canonical manifest
is byte-identical to the existing feature manifest, so no inventory change is
needed in it or the authorized current-chain tests. Historic pins stay intact.

| Selected installation | Measured current inventory SHA-256 |
| --- | --- |
| legacy | 55fda620a186c372c82d35de83888bfb133d0333734334d96a5737af3bcc5113 |
| qualified-bootstrap | 3280c765be6ae0af73e826207c07bce0dfae98cee9604e90503f659c621d7a4d |
| qualified-separate | f230b54b465126402a2ba7a22793e70b80b0bea3da6ca5d1c10502224dffce7b |
| admin-installer | b533e764e09628871a0d1d3709890aa5fde4bb50cb8126ec630ee7e41e839801 |
| admin-operator | 85d9c6c48bb800d00d91d99869d6a1271cb47af8022f96c3cd786c1e5aa80ace |

The handover expectation is the qualified-separate fingerprint above and the
literal 86-table connected graph. The four additions to the previous 82 are
subscription_dunning_cases, subscription_dunning_notifications,
subscription_reminder_ledger and transactional_delivery_receipts. These are
measured expectations, not arithmetic used for conflict resolution. The two
dunning transfer entries still move to the earlier subscription-retry change
and will be dropped from this delta only at merge, as already recorded in the
maintainer packet. The handover changes exactly two source lines: the inventory
literal and the count plus its notice-extended guard message.

The default opt-in handover ran to completion under the focused gate using the
already-local immutable Node24.21.0 image. Its outcome is
LOCAL_QUALIFIED_TARGET_READY_WITH_ONE_FENCED_UNCERTAIN_OPERATION. The report
measures 96 selected units with the exact new forward as tail and the
qualified-separate inventory above. It identifies the owned 86-table graph and
private media root; retires the four-process/coordinator source cohort, recovers
two accepted effects, fences one uncertain operation, and dispatches/replays one
ordinary duty through the actual restricted runtime. Its cleanupFailures list
is empty. This closes the earlier preflight-only witness failure; it does not
claim a larger hosted or whole-store qualification. Raw evidence is retained
locally in .context/scratch/g8-r0-handover.log and
.context/scratch/oss-m14-connected-catchup/journey-rkhLa1/report.json.

### R0 pack growth stop

The real npm packs on the integrated R0 base include the exact packaged SQL and
all generated manifest lines:

| Artifact | Packed bytes | Files |
| --- | ---: | ---: |
| Reconstructed unchanged R0 package | 2,318,731 | 2,913 |
| Integrated notice candidate | 2,323,962 | 2,917 |
| Measured feature delta | +5,231 | +4 |

The baseline reproduces main's reported packed size exactly. Reconstruction
removes only the binding's three source/JS/declaration files and this SQL file,
restores the base index exports and context, and restores R0's SQL manifest.
The candidate tarball's SQL and manifest were checked byte-for-byte against the
worktree. The canonical and packaged SQL retain SHA-256
92eca6c6d7cc9024bdd4260fca3059a2a47e05f3b4296e561dbd16f642cc5971.
No source or SQL behavior changed during this continuation.

This is 159 bytes above the previously reported +5,072-byte SQL-only projection,
which explicitly excluded the eventual generated migration metadata. The new
measurement includes that metadata and the actual R0 packaging context; there
is no added TypeScript. Both real tarballs and measurement.json are retained
under .context/scratch/g8-pack-r0. The about-3-KB target remains exceeded; the
stream cap is unchanged.

The binding no-growth rule requires a stop and report before proceeding beyond
the last reported figure. Result: BLOCKED G8 on this measured growth. The
supervisor was told immediately. All 64 remaining suites are still unrun, with
the exact list retained in the preceding audit table and
.context/scratch/g8-r0-existing-suites.json. There is no new failing test: the
handover passed and its earlier pin failure is closed. The merged build, API
report and five real-PostgreSQL inventory measurements passed. Fresh broad
cheap checks and the requested follow-up DCO commit have not been attempted
after the mandatory size stop; the expressly requested merge commit is already
DCO-signed. Projection, literal-witness and task evidence changes remain local
and uncommitted. No registry pin, checker edit or native review was made.

The working-day estimate remains 1–2 active days for the existing-suite audit,
remaining integration proof, native review and lead-selected verification,
excluding the size decision, resource admission and landing waits. The existing
subscriptions entry covers this export; no new package entry is required. No
CHANGELOG change is present relative to the integrated main, so no note needs
moving to a fragment. The two dunning transfer names remain until their earlier
owner lands; they are dropped only from this delta at merge. OMS exclusions and
native repair-cycle count (zero) remain unchanged.

Self-retro: the build, catalog proof, handover and pack admissions waited 300,
181, 30 and 210 seconds respectively (721 seconds total). The default handover
reached selected-target readiness at 99,164 ms and cleaned up without failures.
A SQL-only projection understated the final R0 delta by 159 bytes; measuring the
complete generated manifest on its real package base before more suites exposes
the budget decision promptly. No optional source simplification is attempted
against this accepted candidate at the size stop.


## Complete-package baseline accepted; existing-suite continuation

The supervisor accepted the complete R0-based +5,231-byte / +4-file measurement
as the package baseline and authorized continuation. Further growth beyond that
figure requires another stop. There is no package-content change in this resume.
The coordinator corrected the earlier message instruction: the handover guard
retains its original “Keep the 8A-extended finite graph unchanged” text. Only the
two fixed, measured literals differ from the issued witness: qualified-separate
inventory f230b54b465126402a2ba7a22793e70b80b0bea3da6ca5d1c10502224dffce7b and
86 connected tables. The four table names are recorded above. The completed
handover proof remains applicable: this correction changes only the diagnostic
message on an assertion whose condition passed, with no new setup or behavior.

The authorized next steps are a DCO-signed projection/pin/evidence commit and the
64 remaining existing suites on this already-merged base. Their test bodies
remain byte-identical to main, except the specifically approved measured pins.
No additional main merge, source/SQL repair, registry pin, checker edit or native
review is authorized. A failing existing suite remains a stop before any repair
that changes source or SQL. The earlier size stop is closed by this decision;
readiness still depends on the remaining suite results.

Pre-commit checks on the merged candidate pass: documentation policy reports
seven obligations and zero unanswered; typecheck reports zero unresolved edges
and zero consumer errors; lint reports zero errors and the same 33 existing
warnings, including eight passing structural-rule test suites. The staged diff
passes gitleaks and whitespace checks. All 2,917 files in the measured candidate
tarball are byte-identical to the current package, so its +5,231-byte / +4-file
figure is unchanged. Both SQL copies and the original signed forward have the
same full SHA-256. The new commit records a refreshed scoped documentation
explanation; no CONTRIBUTING prose or verification policy changes.


## Existing-suite stop: released-schema upgrade count guard

After the complete-package size decision, the authorized projection, measured
handover pins and evidence were committed with DCO sign-off in
f42b0014f6aef7d775193547738faa203908beff. The original handover guard message is
preserved. The remaining-suite runner then executed each unchanged test file
through its own focused resource admission, stopping on its first failing file.

Executed on the integrated R0 base: 47 passing suites / 2,328 passing cases;
one failing suite / one failing case; 16 suites unrun. Earlier pre-R0 evidence
remains 60 passing suites / 3,598 cases. These are separate source snapshots,
not a claim that all 124 suites passed on the final tree. The full file list and
current results are in the table above; per-file raw logs and JSON results are
retained in .context/scratch/g8-r0-existing-runs and
g8-r0-existing-suites.json. The completed default handover remains passing.

Failing suite: tests/postgres/m14ReleasedSchemaUpgrade.test.ts.
Case: upgrades the released 0.23 legacy prefix through real backfill, killed
transactions and exact replay. Its unchanged helper,
tests/postgres/m14ReleasedSchemaUpgrade.proof.ts:60, asserts
units.length === (input.installation ? 94 : 91). G8 adds one legacy forward, so
the selected complete legacy chain now has 92 units and the guard rejects it
against 91. This is the observed causal effect of the new selection, not a
conclusion that the upgrade behavior is sound. The guard runs before container
creation or migration work; the actual backfill, killed-transaction, continuity
and replay assertions have not executed in this run.

The helper's current-count guard is outside the specifically authorized count
and handover-pin locations. Both the test and helper remain byte-identical to
integrated main. No assertion was weakened, derived or changed, and no historic
prefix/inventory pin was touched. The qualified-admin arm still contains 94;
that arm was not executed by this failing legacy test. The helper is also used
by the qualified-admin schema-proof path and recipe conformance, so any ruling
must preserve those callers and their issued-prefix checks.
The smallest proposed correction, not applied, is to retain the fixed guard and
advance only its two current-count literals to 95 / 92, based on the measured
qualified-admin and legacy selections. Actual upgrade proof must then run to its
end; changing a guard alone would not establish that behavior.

Result: BLOCKED G8 at the unchanged released-schema upgrade preflight. The
existing-suite requirement remains incomplete, with no source or SQL repair
attempted. A supervisor ruling on this additional guard is needed before
changing it or claiming released-store upgrade proof. All 64 continuation suite
bodies, including the 16 unrun files, were rechecked byte-identical to main.
The 16 pending suites remain listed explicitly in the table; in particular,
subscriptionComposition, subscriptionManagedStock and
subscriptionRenewalLifecycle are still unrun in this audit.

All 2,917 candidate tarball files still match the current package byte-for-byte.
The real pack remains 2,323,962 bytes / 2,917 files, delta +5,231 bytes / +4 files
against R0. SQL source and package copy retain SHA-256
92eca6c6d7cc9024bdd4260fca3059a2a47e05f3b4296e561dbd16f642cc5971.
No pin, checker edit, source/SQL change or native review was made after the
signed projection commit. The accepted public binding and eight grants remain
unchanged. No new package entry is required; G7's two dunning transfer entries
remain until merge, as recorded in the read packet.

Remaining estimate: 1–2 active working days for the unfinished suite audit,
remaining integration, native review and lead-selected verification, excluding
the count-guard decision, resource admissions and landing wait. OMS: no
supersededByStableJourneyKey, checkoutAbandoned or new dispatched-payment-attempt
store writes. Native repair cycles remain zero.

Self-retro: keeping the existing suites unchanged exposed another fixed current
chain-count guard before any upgrade behavior ran. The broad audit also ran the
long Git-history fixture suites unchanged (691 reviewed-forward cases and 718
source-preview cases). A new passing notice witness cannot substitute for the
unexecuted released-store upgrade path. The simpler response is to report the
exact guard and keep its assertion intact pending the scoped owner decision,
without adding a compatibility bypass or changing SQL.


## Address-change notice repair and released-upgrade continuation

The supervisor extended the approved current-chain literal exception to
m14ReleasedSchemaUpgrade.proof.ts:60. Only its fixed current counts change to
95 / 92; all released-prefix hashes and behavior assertions remain unchanged.
The released upgrade must now execute to its end, followed by the 16 pending
suites. No source or SQL workaround is authorized for an existing-suite failure.

The same resume authorizes one address-change alias in the native binding,
one real-PostgreSQL binding/replay/recipient test, and the owner sentence warning
against composing this binding and the outbox handler for the same event. No new
SQL signature or template edit. This is recorded as one G8 repair per the
supervisor's ruling; no native review command/session is started. The scoped
repair needs no renewed read. A real joined proof with the earlier destination
writer is required at the later main integration, not claimed by this fixture.

Read-only source check: the destination writer's forward
20261101225000_commerce_destinations.sql has SHA-256
3ca1a151b7ad7d7dd01ed7cf40c50d91dfac39f5d2ed1a76e81a9a3743e50413 at inspection.
Its subscription event carries action, payload.shippingAddressId, actor kind/ID,
outcome, appliesFrom, futureDestinationId and priceAgreementPolicy. The labelled
fixture mirrors that shape for applied_from_next_parcel / next_parcel, with a
destination UUID deliberately equal to a different fixture client's ID. This
makes an incorrect destination-as-client lookup produce the wrong contact,
while the correct path obtains the existing customer's contact through
public.dunning_lifecycle_recipient. The captured delivery and accepted receipt
must produce one notice, with none on replay. The payload has destination IDs,
not recipient contact data; the binding passes the scope fields unchanged to
the trusted host renderer.

The existing address template takes host-selected copy, first name and optional
CTA; it does not read destination or parcel state. The public example copy in
both languages explicitly says future deliveries use the new address and never
claims the current parcel moved. It is truthful for the future-only outcome;
hosts retain rendering responsibility, including preserving that distinction.
No template change is made. The new owner sentence requires choosing one notice
path because its event receipt key differs from the outbox handler's key.

A fresh real pre-repair pack reproduces 2,323,962 bytes / 2,917 files and the
previous integrity exactly. The repair has an additional 500-byte maximum;
measure the real post-repair pack before continuing beyond that limit. The SQL
forward remains byte-identical and the eight-grant inventory stays fixed.


Real after-repair npm pack: 2,323,989 bytes / 2,917 files; before-repair pack:
2,323,962 bytes / 2,917 files. The address alias costs +27 packed bytes / no files,
within its 500-byte allowance. The complete G8 delta over R0 is now +5,258 bytes /
+4 files, including the exact SQL copy and generated manifest. Measurements and
both actual tarballs are retained under .context/scratch/g8-address-before,
g8-address-after and g8-address-measurement.json. No SQL or entry-layout change.


## Completed compatibility audit after the address repair

All 64 continuation suites now pass, 2,628 cases in total. Of these, 47 suites /
2,328 cases ran on the R0-integrated candidate before the address alias; the
17 resumed suites / 300 cases ran after the alias and approved count correction.
The earlier 60 suites / 3,598 cases remain pre-R0 evidence. The cumulative table
therefore records 124 passing suites / 6,226 cases across those explicit source
snapshots, not a claim that every suite was rerun on the last tree. Every one of
the 64 continuation test bodies remains byte-identical to integrated main.
The approved released-upgrade helper differs only in its two current counts;
all historic hashes and upgrade assertions remain unchanged. The released
upgrade now executes its backfill, transaction-kill, continuity and replay
assertions to completion. The default handover remains passing as recorded.

The full native notice suite passes 15 cases on the repaired binding, including
one future-only address-change notice, existing-customer contact read through
the native recipient function, actual captured dispatch and no send on replay.
G3's writer is absent from this base; that one event is the explicitly labelled
shape fixture described above. The real destination-writer join remains a
required proof at later main integration. The owner warning requires one event
consumer path because the binding and outbox handler use different receipt keys.

The new test's first attempt incorrectly used raw contact text as the delivery
recipient reference, violating the existing opaque-identifier contract. It was
corrected to the existing client reference; its strict recipient equality and
capture/replay assertions were retained. All 14 existing notice cases passed
on that attempt and all 15 pass after the fixture-only correction. No production
change beyond the authorized alias was needed.

The exact verify neutrality command initially found two provider tokens in the
public table's existing test-path labels. The complete exact paths and results
are retained in the local JSON and maintainer packet; the public table uses
neutral labels for those two provider suites. This changes neither test execution
nor scope. No neutrality checker or baseline entry is changed. The command is
rerun on the complete candidate before sign-off.


Final repaired-candidate checks pass: full notice suite 15/15; all 64 continuation
suites 2,628/2,628 cases; build and unchanged API report; strict typecheck with
zero unresolved edges and zero consumer errors; lint with zero errors, the same
33 existing warnings and eight passing structural-rule suites; focused AST and
whitespace checks. The exact verify neutrality command against the full R0 base
reports zero increases, without a baseline or checker change. Documentation uses
a refreshed scoped tests trailer rather than CONTRIBUTING prose. All 2,917 files
in the after-repair tarball remain byte-identical after the final build/lint.
The real +27-byte repair / +5,258-byte complete feature measurement is unchanged.

Local implementation, approved owner read and focused proof are ready for the
supervisor's review slot. The existing admission-class dependency still governs
landing; no registry pin, checker edit, native review, canonical verify, external
write or release action is performed. At main integration, drive the actual
destination writer through this binding, remeasure rather than add chain/graph
counts, and remove only the two duplicate dunning transfer entries supplied by
the earlier retry change. The current labelled event fixture does not replace
that joined proof. No further package entry wiring or SQL signature is needed.

Remaining estimate stays 1–2 active working days for that integration, native
review and lead-selected verification with ordinary bounded repairs; resource
and queue waiting are external elapsed time. The supervisor records the address
alias as one G8 repair; no native review session or counter is created or reset
here. OMS: no supersededByStableJourneyKey, checkoutAbandoned or new location for
a dispatched payment attempt.

Self-retro: the additional literal-count exception allowed the released upgrade
assertions to execute rather than bypassing them. The address test caught an
author fixture mistake against the existing opaque-reference contract; using
the existing client reference kept recipient assertions strict and avoided any
new production seam. The complete pack measured the bounded repair at 27 bytes.
Running the exact neutrality command also caught provider names in public audit
labels; neutral prose plus the exact private inventory preserved both the
publication boundary and complete execution evidence without a ratchet change.
