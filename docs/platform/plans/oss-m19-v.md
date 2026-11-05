# Native lifecycle notice routing and retry

Status: local delivery candidate; API owner read and final predecessor integration remain pending.

## Outcome and authority

Render operator-requested payment repair notices using the latest same-case
customer payment-failure template, preserve transient delivery retry, and keep
old recovered history silent through the existing native notice consumer.

The maintainer authorized local implementation, tests, documentation, API
preparation and a staged work-in-progress snapshot under the approved lifecycle
notice programme. The task supervisor coordinates this package leaf. Its train
position follows the notice owner and precedes the operator commerce continuation.
The remaining train continues through account consent, acquisition terms and
the joined recovery host. The API owner read precedes sign-off and committed
review. The lead will supply the final predecessor for restacking and full review.
The current code base is `e486bbf2d11939968960cb4ac924ce5e3d9e6063`.
The separately fetched policy revision is
`7249a750addf64fea1da42fa87e77467794da09c`.

## Scope and acceptance

The production change belongs to `postgresLifecycleMessages.ts` in the platform
subscriptions owner. It preserves the operator notice identity while inheriting
the latest customer failure template ordered by creation time and UUID. A
missing source produces a sanitized refusal. The existing pure lifecycle mapper
retains its separate typed-fact contract.

Known transient delivery failure requeues using a configured delay and the SQL
clock. Explicit final failure settles failed. Missing disposition means
transient. Read, bind, send and finalization exceptions preserve the sending
lease for recovery. Accepted receipts are read before binding or eligibility
checks and reconcile the same notice without another send.

Unaccepted recovered notices require the current case to be recovered and its
recovered timestamp at or after the configured inclusive SQL-clock cutoff.
Ineligible history settles skipped. The direct recovered queue remains the
single producer and its existing case identity owns dedupe.

The optional constructor policy uses lease seconds 60, maximum attempts 6,
transient backoff seconds 900 and recovered window seconds 172800. These are
neutral safety defaults. Starter composition must pass all four values explicitly
from typed adopter configuration. The lease and attempt defaults preserve existing
native literals. Fifteen minutes supplies a bounded demo transport retry interval,
and two days bounds delayed recovery history without mailing an unlimited backlog.
Strict
validation precedes claims. The delivery failure result accepts an optional
retryable boolean, and the run result reports requeued notices.

Acceptance requires real restricted-runtime PostgreSQL proof of source routing,
refusal, retry disposition and timing, current-case truth and inclusive cutoff,
accepted/lost-acknowledgement replay, stale claims and uppercase UUID values.
Non-default policy values must reach SQL. Compare payment, subscription,
alignment and parcel rows including tuple versions before and after delivery.
Run the database witnesses in the default zone and both configured non-UTC zones.

## Recovery host handoff

The following seven-step contract is frozen for the separately owned recovery
host. The coordinator accepted the split. The starter owner implements the host fence,
private capture protocol and authenticated retry. This package leaf owns the
frozen contract and its public/private handoff records.

1. Resolve a claimed notice through its current case, cycle, retry obligation,
   renewal operation and pending order. Require the same subscription and client
   through typed UUID equality. Automatic repair follows active-service authority.
   Operator-requested repair uses its existing human command receipt and issued
   path.
2. Retain one protected rendered message artifact per existing notice key. Use
   the established private capture boundary with directory mode 0700 and file
   mode 0600, exclusive durable creation and readback. A later attempt requires
   its original artifact. Conflicting or missing prior material refuses delivery.
3. Use the existing case issuer under the owning transaction locks. Hash the
   original artifact token and read native authority first. Reuse an exact active
   hash for the same order, client and expiry without issuing again. A first
   issue requires immediate native hash/context readback within its transaction.
   Ambiguous commit acknowledgement requires readback before further action.
   Revoked or consumed authority requires a separate explicit owning reissue.
4. Freeze expiry against durable failure or next-retry facts with validated
   host configuration. Preserve exact stored timestamps. Operator links retain
   the expiry actually issued. Delivery retries retain their original expiry.
5. Render the configured localized repair route and deliver the same private
   artifact idempotently. Supply opaque recipient, template and token-UUID
   references to transactional delivery. Acceptance follows artifact readback,
   then the durable receipt and claim-fenced notice finalizer. Raw tokens belong
   only in protected message material and initial navigation. Logs, outbox JSON,
   receipts, audit responses and public evidence contain opaque references.
6. Capture the initial link token before login navigation and remove it from
   browser history. Authenticate the customer, check ownership and native token
   context, then authorize and schedule recovery of the original unpaid
   obligation. Native method evidence and verified retry execution own paid truth.
7. Initial-checkout actions require proof that their order has no recurring
   renewal operation, retry obligation or dunning case. Apply this admission to
   guest tokens and authenticated order access. The repair route requires the
   positive recurring chain. Order mode alone cannot distinguish initial
   subscription acquisition from a recurring cycle.

The shared checkout-token table and case issuer retain their current ownership.
The lower-level issuer revokes live tokens before its hash-conflict branch,
which makes blind same-hash replay unsafe. The existing operator command receipt
returns before rotation. The host must prove its capture and acknowledgement
handoff before serving recovery links.

## Reachability and limits

The reference adopter reaches customer failure and recovered mail through its
explicitly enabled scheduled dunning job. Human support commands request repair
mail, and authenticated account recovery follows its token owner. Guest checkout
uses its own recovery authority. Its declared served composition uses the
managed rail. Its direct captured composition requires explicit selection.
At the inspected source revision neither changed native-binding module nor its
pure lifecycle mapper has a reference-adopter import. Native construction starts
no job or HTTP route. The package binding remains default-off until selected by
a trusted host.

The separately owned host implements the frozen handoff. This leaf covers the
three native notice behaviours and their evidence. Real payment providers,
method setup, other reminder windows, service pause, replacement attestation,
new SQL, grants, migrations, token storage, release controls and package entries
remain outside this task's authority. Subscription service remains active during
mail failure. Late delivery retains its monotonic next-cycle alignment rule.

## Proof and completion evidence

The source characterization and private mapping accompany the API read packet.
Use the existing PostgreSQL installer and restricted runtime, the unchanged
notice/checkout/operator suites, focused characterization and installed-consumer
proof. Run the API reports, policy/documentation checks, typecheck, lint,
structural rules, neutrality, privacy, catalog modes and secret scan. Measure
an official-toolchain pack against the exact code base before the API handoff.
The package delta allowance is 3000 packed bytes and 1800 code gzip bytes.

The prior focused database evaluation recorded 30 passing delivery cases and
three failing operator-issuance cases. The task supervisor accepted the existing
precedent for a delivery precondition. The real operator routine now creates the
queued notice through an owner connection, explicitly labelled as precondition
setup. Claim, source routing, private capture, receipt and finalization execute
under the restricted runtime. A separate named known-limit witness pins the
restricted operator refusal below.

The complete generated API check passes across all 68 surfaces. The sole snapshot
delta is `subscriptions.api.md`. Strict publication typecheck reports zero
unresolved edges and zero consumer errors. Lint passes with zero errors and 66
warnings; all eight structural rule suites and the focused scan pass. Both
repository and UI neutrality checks pass.

Unchanged regression results: facade 43, reference facade 2, native notice 16,
operator PostgreSQL 23, checkout recovery 3, checkout operations 5, operator unit
6, checkout-token unit 12, transactional receipts 3 and cold-consumer unit 122.
All pass. Policy validation adds 47 passing cases. The three-zone delivery matrix
passes 36 cases, including three named known-limit refusals. Privacy assertions
hash the existing recovery path before comparison and report only operator
outcomes, keeping raw links out of assertion diagnostics.

The unchanged upgrade and catalog suites refuse while loading the inherited
registry, before executing cases. Those failures are retained below. Offline
consumer, final documentation policy, size and staged secret-scan evidence follow
in the private API packet; no clean committed-candidate stamp is claimed.

## Known limits

`F-QUALIFIED-RECOVERY-COMMAND-LOCK` owns the pre-existing native operator issue
limit. On the qualified restricted runtime the real operator routine returns
SQLSTATE 42501, permission denied for `customer_recovery_commands`, while its
command, recovery-notice and token row counts remain zero. The routine takes its
command receipt `FOR UPDATE` and the installed append-only grants provide
SELECT and INSERT. The named refusal witness records the limit. Owner-created
preconditions establish the queued delivery input, and delivery proof begins
at the restricted claim. Runtime operator issuance remains unavailable until
its separate owner closes this limit.

The frozen predecessor also carries an older native forward class than its
feature bindings. The unchanged upgrade suite and native catalog suite refuse
with `reviewed native store feature path, order or inventory drifted` before
loading tests, so neither catalog service-role mode has run on the raw tree.
The predecessor task already records this co-location limit. This leaf changes
no registry, control reader, SQL or pin to bypass it. The instructed final
predecessor integration and its ordinary gates remain necessary.

The current run has consumed zero committed-review repair cycles.

## Self-retro

The implementation reuses the existing claim, result and receipt ports. Source
routing distinguishes operator issue sequence from the underlying payment rung.
The handoff retains source ownership and makes private-artifact readback an
explicit proof requirement for the recovery host.

### Fixture regroup

Two initial database evaluations stopped on fixture assumptions. The first used
cascading truncate and reached an append-only channel table. The next assumed
an order subscription column and changed the global alignment mode while later
fixtures still inserted cycles under the default-mode shape. Old event sources
also survived across cases without accepted receipts. The fixtures now use the
existing order-to-cycle join, populate the conserved alignment row explicitly,
and drain earlier sources through real transactional receipts before each case.
The next discriminating run must reach every restricted-runtime assertion.
Fixture ownership assumptions → existing schema and receipt cleanup.

The next evaluation reached the binding. It exposed the inherited courtesy
producer's broad future-cycle selection and session-dependent JSON timestamp
rendering in the conservation observer. The fixture now captures courtesy duties
through the existing delivery receipts before dunning assertions, and observes
rows from a fixed-zone owner connection. Native runtime calls still run in all
three required zones. This keeps unrelated source work visible and leaves
production reminder policy with its existing owner.

### Stop retro

The fixture corrections exposed an actual runtime boundary that prior source
reading had missed. EXECUTE and SELECT/INSERT grants alone do not prove a
routine's locking permission. The next operator-issuance step belongs to its existing owner. The supervisor
accepted owner-created preconditions and a named restricted-role refusal pin
for this delivery leaf. The task retains all four evaluation logs and their failure
history. No committed-review repair cycle was consumed.

### Resumed proof retro

The native operator precondition now uses its actual owner routine, and the
restricted runtime proves delivery independently of the inherited issuance
failure. A separate exact refusal pin preserves the missing locking authority.
The raw control registry refusal is likewise retained rather than hidden by a
local control repair. Separate preconditions from runtime claims at each owner
boundary. Token-bearing diagnostic objects are projected to hashes or outcomes
before assertions.

<!-- openlup-task-doc-impact {"unit":"tests","doc":"CONTRIBUTING.md","anchor":"#development-preview-checks","digest":"sha256-18a632091e88ff1efbc43d9f600c5ea2240a71b23e7a386d8e3928da904821b7","reason":"The added characterization uses the existing package and PostgreSQL test discovery, canonical qualified installer, restricted runtime and disposable container helper. Owner access prepares synthetic fixtures and observes fixed-zone rows with xmin. Existing suites retain their assertions. The three configured zones and local captured artifacts add no collector, grant, role profile or required job. The inherited operator locking refusal is pinned as a named known limit; owner-created queued inputs are explicitly preconditions, and delivery assertions use the restricted runtime. Thirty-second per-case budgets follow the existing measured-timeout rule. Contributor commands, required proof and retry rules remain applicable."} -->


## Combined candidate after renewal integration

The current delivery combines native order notices, paid shipping, payment
recovery notices, retained renewal terms and account communication choices in
one candidate and draft pull request #534. The exact review and documentation
predecessor is `84f146305d99cf3f30831ab1cc6fb65de1ffe1ca`. The policy revision read for
this continuation is main `76d8a415a5bb96331e5f81832670138df17b2536`.

The assigned worktree now uses `codex/oss-m19-g8`. The authorized delivery covers
the signed predecessor merge, measured inventory and literal regeneration,
complete caller and pre-review checks, two fresh full reviews, exact-tree local
verification, draft fast-forward publication and the existing landing command.
The source behaviour, SQL statements and public API remain bound to their
accepted reads. A needed SQL, API or TypeScript change returns for the lead's
read. An open material review finding returns to the owner.

The integration keeps both renewal test sets byte-for-byte, the predecessor's
240-second qualified bounds and 40-second released-upgrade bound, and the
historic schema pins. Five current inventories were derived on PostgreSQL
through the canonical projectors. The merged installations contain 98 legacy,
102 qualified-v2 and 101 qualified-admin migration units. The transfer graph
contains 112 tables. Current-main class and co-location checks pass, including
all three native forwards and 17 recomputed function preimages.

The remaining acceptance before review is the complete gated scanner set,
caller sweep in three PostgreSQL session zones, composition, handover, catalog,
static and package checks, and the cumulative package checkpoint. The combined
packed delta must fit 32,500 bytes and the absolute code measure must leave at
least 10,000 bytes below 2,055,017 bytes. Native review, final verification and
landing follow only after that evidence is complete.

Self-retro. Preserving the selected migration order and recomputing the current
inventory keeps an integration from rewriting historic schema expectations.

## Combined candidate after native fulfillment-read integration

The current combined delivery is based on main `313eda258c8a8afa90e053623dea91922d1a2baa`, integrated by merge `dd9e7080295c0fb8a8678a641a99082a9a363029`. No stack pin applies to documentation, native review or verification from this point. The merge is the exact conflict-free Git merge-tree prediction; API regeneration adds no changes and the catalogue is the exact sorted union. The approved combined scope and remaining review and delivery gates continue to apply, including the explicit train-front check before landing.
