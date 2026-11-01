# Native lifecycle notice dispatch

Status: implementation complete and maintainer read accepted for DCO sign-off
with scoped diagnostic/documentation corrections; forward admission and later
integration/review remain pending. No publication or
live-provider qualification is claimed.

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
projection remain with the foundation prerequisite until it lands; neither
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
