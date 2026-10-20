# Canonical Contracts

Status: development-preview contract. These rules define the intended public
behavioural boundary; they do not assert a stable provider catalogue or release.

## Canonical status

Each domain owns its canonical status vocabulary, allowed transitions, and
terminal-state rules. A provider's raw status is evidence at the adapter edge;
it is mapped into a domain fact before it affects durable platform state.

Do not compare provider strings throughout application code or treat a browser
return value as settlement truth. Preserve the raw evidence needed for diagnosis
in a bounded form, map it once, and refuse impossible transitions. Late,
duplicate, or out-of-order evidence must not regress a terminal canonical fact.

Status vocabularies are not interchangeable between domains. A new status or
transition requires an explicit mapping, persistence compatibility, and tests
for refusal, replay, and ordering.

## Idempotency

Every externally repeatable write has an idempotency scope, a stable operation
identity, and a request fingerprint. Replaying the same logical request returns
the established result without a second durable effect. Reusing a key for a
different fingerprint is a conflict, not permission to overwrite history.

Idempotency keys are opaque values with documented derivation and scope. An
operation, a provider attempt, a customer journey, and an inbound event may
require different keys; do not collapse them into one user-controlled value.
Persist the ledger before reporting success, and make concurrent repeats resolve
to one canonical effect.

## Provider adapters

Domain code depends on a port, not on a provider SDK. An adapter translates the
provider protocol, verification evidence, and failure facts into the port's
neutral contract. It must carry the platform's identity fields without changing
their meaning and expose declared capabilities rather than relying on provider
name checks in domain policy.

An adapter needs conformance coverage for success, refusal, malformed or missing
evidence, duplicate delivery, out-of-order delivery, and retry/replay. Reference
fixtures demonstrate these behaviours without live provider access; they do not
prove a provider integration, release, or support tier.

### Opt-in Node protocol adapter

`communications/resend` is an experimental Node-only subpath.
It exports exactly three functions: guarded transport creation, authenticated
webhook handling and GET-only delivery reconciliation. Types remain on the existing neutral entries.
The neutral communications and browser contracts entries expose no vendor factory.

Every `.send` enters `createGuardedEmailTransport` before the internal POST.
The host supplies the policy and environment tag name; only the validated
credential, effective recipient and environment tag reach the provider. Missing,
throwing, malformed or blocked policy causes zero POST; drop is terminal
`ok + suppressed` with zero POST. Optional payload keys, exact idempotency-key
bytes (including empty), abort and 2xx acceptance without an ID retain the
reference transport shapes. Acceptance is not delivery.

The webhook authenticates the original string/UTF-8 bytes before JSON parsing,
using the provider bare or `v1,` signature-member dialect, literal or canonical
`whsec_` keys, a UTC-seconds clock and an inclusive ±300-second window. This
policy is separate from the standard Auth verifier's normalization and grammar.
Explicit foreign environment tags stop before lookup or convergence; the
receiver defaults to non-production. Admitted events use `processEmailObservation`:
lookup/apply errors retry with 500, while attempt telemetry cannot overturn
success. Unsupported or missing-ID events are ignored. Event metadata is opaque.
Webhook and poll observations retain the raw `email.*` provider event type;
the webhook event inventory is an admission gate only.
The webhook returns a fixed 500 body on processing failure and only an HTTP
disposition for unsupported, missing-ID or foreign events.

Reconciliation delegates to `runDeliveryReconciliation`, with internal GET reads
of host-selected existing IDs. Only failed 404 reads contribute to the existing
three-consecutive-404 abandonment rule. Auth/network/provider errors remain
separate; sent and unknown snapshots stay pending. Polls feed the host's existing
atomic writer and never recovery-send. No route, schedule, store, credential
reader or reference binding is installed. Fetch is injectable; no SDK or new
dependency is required. [A1 evidence and limits](plans/oss-a1-communications-adapters.md)
are protocol-only; account verification remains pending.

## Subscription lifecycle

The subscription status matrix has one meaning and several spellings. The
managed SQL guard `public.subscription_guard_status_transition` fires before
every status update. The core engine publishes the same matrix, restricted to
the four statuses it manages, as `SUBSCRIPTION_STATUS_TRANSITIONS` in
`@openlup/core/subscription`:

| From | To |
| --- | --- |
| `active` | `paused`, `cancelled`, `completed` |
| `paused` | `active`, `cancelled` |
| `cancelled` | `active` (the owner's win-back) |
| `completed` | none; terminal |

The guard's other edges belong to the activation flow, which the engine never
drives: `pending_activation` to `active`, `activation_failed` or `cancelled`,
and the reopen of an abandoned checkout from `cancelled` to
`pending_activation`, which the guard admits only with an audited
`subscription.activation_abandoned` event. `activation_failed` is terminal.
The core contract test, a pgTAP suite over the guard, and a parity test that
reads the guard's live body all pin the matrix. A change to one side must
update the others in the same contribution.

A matrix edge is not a licence for every operation. Only the owner's pause
request, and the non-payment rule below, may move an active subscription to
`paused`. Among the engine's statuses, only the win-back leaves `cancelled`: it
needs a stored payment method and restarts the schedule two days out.

**The sanctioned non-payment rule.** Nothing suspends, freezes or interrupts an
active subscription except a renewal whose refusals ran past the last rung of
the retry ladder. That cycle has failed, has no retry scheduled and has an
attempt number beyond the ladder's length. It pauses the subscription and
records `subscription.paused` with reason `payment_failed_expired`. A ladder
cut short by a terminating refusal class, or a failure that still has a retry
after it, leaves the dunning case open and the subscription active. The
customer's recovery resumes the paused subscription: it skips the uncollected
cycle and restarts the schedule two days out. A plain resume must not be used
for a subscription this rule paused, because it neither skips that cycle nor
moves a stale `next_cycle_at`. The managed SQL side is
`subscription_handle_payment_failure_dunning` and
`subscription_resume_after_expired_dunning`. The engine side is
`isDunningLadderExhausted`, `pauseSubscriptionForExpiredDunning` and
`resumeSubscriptionFromExpiredDunning`.

The engine models the decision; the host keeps the durable duties the managed
SQL restarts also perform. Both restarts require the customer's confirmation of
the charge timing. A win-back also clears `ended_at` and the cancellation
reason, refuses while a cycle is locked, and bumps the template version. A
recovery also requires a method that is chargeable unattended, not merely
present, and skips every uncollected cycle of the subscription, not only the one
it was given.

The two sides restart the schedule differently. The engine re-arms
`next_cycle_at` at the later of the stored instant and two days out, so a
restart never moves it earlier. The managed SQL restarts assign two days out
unconditionally. For a win-back from a subscription paid through a later date,
the SQL side therefore charges earlier than the engine would.

**Known limitation: the portable chain.** The portable PostgreSQL chain in
`db/platform/migrations` does not yet carry this matrix. Its `subscriptions`
table admits only `active`, `paused` and `cancelled`, so it has no activation
statuses and no `completed`. It has no status-transition trigger: each lifecycle
function checks its own source status. It can send a win-back message to a
cancelled subscriber, but no function reactivates a cancelled subscription.
Its dunning rail, `dunning_lifecycle_handle_failure`, has no rung fence: it
expires the case and pauses an active subscription whenever the next retry
instant it is handed is NULL. A class-terminated refusal on rung one also has
no next retry, so a caller that hands its schedule straight through would pause
a live subscription on the first refusal, which the rule above forbids. No
caller in this tree invokes it today. A future caller must not call it with
NULL unless `isDunningLadderExhausted` holds for the refused cycle. A case cut
short earlier must stay open without that call. An adopter on the portable chain therefore cannot store a
completed or provisional subscription, and cannot reactivate a cancelled one,
until a forward migration closes the gap under the compatibility lifecycle in
[Data and migrations](DATA_AND_MIGRATIONS.md).

## Subscription delivery alignment

An active subscription must not admit its next renewal while the customer is
still waiting for the preceding delivery. Renewal admission records durable
protection for an undelivered obligation; an already-created
`retry_scheduled` cycle remains existing recovery authority rather than a new
renewal. A delivery that resolves the delay moves `next_cycle_at` to the
delivery or confirmation instant plus the stored cadence. The durable update is
monotonic and uses SQL `GREATEST`, so alignment may extend a cycle but never
move it earlier or stack deliveries on the customer.

A replacement parcel does not erase the obligation merely because it was
created or dispatched. Once a row names an earlier parcel through
`replaces_fulfillment_order_id`, that superseded predecessor is no longer an
outstanding obligation; the latest unsuperseded replacement remains outstanding
until it reaches the customer. Its arrival may settle the predecessor's case as
`aligned` without fabricating `delivered_at` for the parcel that never arrived.

`subscription_delivery_alignment_confirm_replacement` is the service-only path
for recording that a substitute shipment reached the customer when durable
delivery evidence cannot do so. Never use it for an in-flight, lost, or otherwise
undelivered replacement: `aligned` means the delivery happened. Replaying an
already aligned confirmation returns the stored aligned schedule and must not
add another cadence. The ordinary operator-resolution path refuses while an
active subscription still has an unsuperseded undelivered parcel; refusal leaves
the protected case and schedule unchanged.

These are source and persistence contracts, not evidence that any hosted
deployment, provider adapter, or public release has activated the rail.

## Compatibility posture

Bundle application/admin now has package ownership in the existing catalog server
entry with named reference compatibility bindings. Read-error identity is shared
through its shim; the RPC subclass stays reference-owned and is injected into
handlers. Validators, their defaults/strictness and operation/MCP/flag authority
remain at the reference boundary. Catalog contracts publish plain DTO types only.
Existing composition order, stock unknowns, allocation and preview selection are
preserved. No database gate, actor-history parity, mount or stronger replay claim
follows from this application move; the bundle pending ledger owns those outcomes.

Promotion admin DTOs and server schemas now have package ownership with named
reference compatibility exports. The structural-slice inventory follows the
moved native-store and admin tests; this is a source-location update, not a
new runtime capability. Reference wrappers preserve the shared admin kit/error
identity, currency validator and managed adapter fences. Sparse SQL 47/48
projections retain canonical bytes and positions without changing installation.

The subscription reference's closed browser import inventory includes exactly
`pricing/contracts/index.js`, `acquisitionTerms.js`, `offerPolicy.js`, `policy.js`, `quote.js`,
`provenance.js` and `offer.js` from the emitted
platform package. Its retained browser policy schemas consume those version
constants through the package entry; schema validation and wire pairing remain
unchanged. The quote and provenance modules retain their wire-version constants; the offer
module also exposes the additive v3 constant. Money/evidence DTOs erase at build time. The inventory admits no pricing server entry, token crypto, readiness
or secret configuration. [The pricing package](../../packages/platform/README.md#pricing)
owns the extracted authority and DTOs. Acquisition DTOs and protocol identities
are additive; their schemas, required host financial policy, selector and
readiness live only in the server entry. The reference supplies no acquisition
configuration and its request admission and token envelopes are unchanged.

The communications import inventory grants first-party browser imports only to
the explicitly selected disposable profile. It does not change ordinary public
mutation/webhook admission, deployment routes or default clocks. Native diagnostics
are bounded installation observations, not managed-frequency or full-native-sender
parity. A built shell does not establish an email destination or T07 action.


The opt-in direct OIDC settings registry declares issuer and separate customer
and operator API audiences. Selecting them adds no browser provider or default
login route. Invalid or overlapping audiences refuse composition; managed bundles
retain native federation sessions. The [identity contract](IDENTITY.md#opt-in-oidc-access-tokens)
owns the additive verifier API, deterministic principal mapping and refusals.

The disposable identity reference's run directory, run id and local mail origin
are evaluation settings bound to one owned installation. They establish no
persistent customer identifier, package API version or migration contract. The
selected browser import inventory is independent of the public default build;
server credentials do not become browser configuration.



Identity privacy appends the direct receipt migration at position 69 while
preserving the preceding manifest entries and SQL projection identities. Erasure
requires this forward, explicit contributor registration and declared retention
ownership. It preserves contact IDs and auth links, refuses active/resumable
subscriptions, and records atomic replayable identity completion. Managed erasure
returns `MANAGED_PRIVACY_ERASURE_UNAVAILABLE` with no managed migration or new
grants; export exposes its narrower coverage. See
[identity privacy](IDENTITY.md#identity-personal-data) and
[data compatibility](DATA_AND_MIGRATIONS.md#compatibility-lifecycle).


Direct human operator sessions introduce a distinct operator audience and a
browser provider-selection setting. The direct catalogue appends the challenges
forward with an immutable predecessor prefix. Its normalized-email uniqueness
constraint refuses ambiguous identities; customer links and machine credentials
are preserved. [Identity](IDENTITY.md#direct-human-login) owns the authentication
codes, limits and compatibility requirements; no managed migration is added.


The environment registry declares `IDENTITY_EMAIL_VERIFYING_PROVIDERS` as an
optional server-only value with an empty default. Managed identity hosts parse
its comma-separated provider identifiers as explicit assertions of mailbox
verification; malformed declarations refuse configuration. This setting changes
email-association admission, without changing stored identities or schema. See
[identity policy and migration](IDENTITY.md#responsibility-and-composition).

Operator invitations add a bounded TTL for direct hosts that call the parser and
one append-only direct migration manifest row. Such hosts refuse malformed TTL
values before writes; the managed reference runner neither calls the parser nor
enforces invitation expiry. Its lifecycle outcome data replaces the old message-only invite
response; active/pending-role/identity conflicts use explicit 409 identity reasons.
Managed revoked-row reinvitation refuses with `MANAGED_REINVITE_UNSUPPORTED`.
[Identity](IDENTITY.md#operator-invitation-lifecycle) owns the DTOs and acceptance
boundary; [data compatibility](DATA_AND_MIGRATIONS.md#compatibility-lifecycle) owns
the direct catalogue identity and the managed pending-lifecycle compatibility gap.



The runtime forward registry may pin exactly eight legacy browser-policy
retirements alongside its fixed function and privilege bindings. Retirement
checks exact names, tables, preceding statement hashes and ordered DROP
statements; it does not admit arbitrary RLS changes. The approval must exist
unchanged at the feature comparison base and the forward introduction parent.
Control approval installs no database permission and cannot stand in for the
corrected forward's actual-role tests.

The publication catalogue now includes the ordered runtime capability forward
and its actual-role and renewal-lock witnesses. The derived source contract
binds that inventory and its classifications; it does not grant permissions or
change package APIs. Runtime authority comes from the separately admitted SQL.

The optional runtime-forward registry is a finite security admission: it pins
one or two files with ordered exact grants. The first pins five unchanged
existing function identities; the checker independently limits its service
columns and four existing callable functions, plus authenticated profile/membership
reads and two pure index helpers. The optional second pins the identity
capabilities file with no functions or policies, only service_role INSERT on
`clients.email`, `auth_user_id`, `acquisition_source` and `lifecycle_stage`, and
UPDATE on `auth_user_id`, INSERT on `admin_users.id`, `email`, `role`,
`membership_state`, `membership_provenance` and `membership_accepted_at` for
operator activation (`is_machine_actor` keeps its false default), and SELECT on `admin_users.email`
for invitation eligibility and conflict checks.
It does not authorize arbitrary runtime grants. Approval must precede the SQL
feature's comparison base and introducing commit; registry installation alone
does not change database permissions.


Stable status, idempotency, and provider-extension commitments wait for the stable-framework requirements.
Before then, changes must still preserve the contracts above and state their
preview compatibility boundary explicitly.

The [reviewed function-forward approval data](../../config/reviewed-platform-forwards.json)
binds exact managed SQL files and old/new function definitions. Its replacement
list contains exactly three existing signatures in two files; a distinct creation
list requires the two price-setup signatures to be absent before their forward.
The optional runtime list pins the capability and identity forwards described above.
Required self-check keeps the whole registry unchanged from the feature comparison
base. Release compares each forward's own entry, list position and shared registry
fields with its introduction parent, allowing later controls to append approvals.
A feature cannot approve itself. Both gates share the same admission checker.
This is a separately reviewed preview admission class, not expand-only or a live
database compatibility proof; see
[Data and migrations](DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards).

While `@openlup/core` is below 1.0, every `@openlup/*` package is released in
one set version `0.N.P` from one commit, each package with its own tag
`openlup-<package>-v<version>` at that commit, and a source preview carries no
package. `release:bump --set` prepares every publishable package's version,
and every exact internal pin on one, in its manifest and lockfiles.
`packages:check` and `@openlup/core`'s release check admit only a set version
below 1.0, `packages:check` refuses publishable packages at different
versions, and the package release workflow refuses a version that differs from
the manifest or that npm holds or has passed. `publish-package.yml` with
`package: all` releases the set under one approval, one tag and immutable
release per package at the set commit. Dispatching the same set again resumes
it: a package npm holds with the same tarball is skipped, a package whose
release exists but npm lacks the version waits for the re-run of its failed
publication, the rest are released, and any other state stops the set. A patch
set is refused when a package's API snapshot differs from its previous set's
release tag. Historical previews retain
their recorded package versions. This is release identity, not a stable
compatibility promise.

The subscription browser profile's closed import list follows the package
exports selected by its build. Core entries therefore name built `dist/*.js`
modules; source paths are not an alternative runtime route. The core workspace
must be built before checking that profile's import closure.

The repository's
[`neutrality baseline`](../../config/openlup-neutrality-baseline.json) records
existing source findings rather than declaring the tree free of them. Its full
source commit identifies the measured base, scanner blob identities pin the
counting implementation, and SHA-256 keys identify exact relative paths. Each
count belongs to one path and category; a reduction elsewhere cannot pay for an
increase, and a new path has no inherited allowance.

The [repository check](../../scripts/public-ci-neutrality.mjs) counts text
regardless of filename extension and inventories binary files. It refuses
increases against both the comparison tree and the accepted baseline, including
an increased baseline allowance. Regeneration may lower existing allowances;
it cannot admit new debt except for the fixed diagnostic-fixture introduction
recorded in the checker. That introduction admits five exact SQL fixture files
in category `ui-15`, verified by their complete SHA-256 bytes, original counts
and accepted counts, against one full comparison commit. The explicit baseline
recalibration is required; the candidate still must fit that baseline. A later
comparison commit uses the ordinary ratchet, including refusal of regrowth after
a reduction. Scanner pins and every other path, category and increase remain
unchanged. These counts reuse the existing scanner semantics and do not expand
a runtime contract or establish a stable preview channel.

The opt-in communications adapters have a `ui-12` vocabulary allowance only
inside their two declared source/test directories, their exact API reports and
exact cold-consumer proof lines. The exact path-segment tokens
`communications/resend` and `communications/klaviyo` are additionally allowed in
the platform manifest, release gates, package boundary test, publication
catalogue, changelog, this page, the architecture page and the A1 ledger.
The two snapshot filename tokens are additionally allowed only in the platform
release-gates file and publication catalogue; the two relative adapter entry
tokens are allowed only in the package boundary test. The undeclared-subpath
fixture uses a neutral vendor segment and needs no allowance.
Only the ledger additionally allows bare adapter names. Neutral communications
sources and contracts, other root content and other documentation remain
checked; baseline counts and matcher pins are unchanged.

Published Tree CI enforces that ratchet in required `self-check` and exercises
its CLI refusal tests in required root `test`. Managed pgTAP remains a raw
diagnostic; follow [testing](../../CONTRIBUTING.md#test-scope-and-diagnostics)
for execution and proof limits. These checks do not grant application privileges
or declare complete compatibility evidence. Existing release context checks remain unchanged.

The outbox rail is a local experimental package candidate in the package catalogue. Its exact core peer, export snapshots and shipped baseline hash are separate from publication eligibility. Admission compares the complete observed set and selected adapter facts; unknown inventory or probe state cannot activate a candidate.


### Native communications evidence

C-compose adds binding-scoped message lookup and bounded delivery evidence.
Foreign references produce no unrelated row; ambiguous message identity refuses.
Only the six native observation states can reach the fact writer. Open, click,
scheduled and unsupported provider events never become delivery. The existing
raw-byte signature/environment admission remains before the native bridge.

Native signed-token preferences commit denied/suppressed authority and default
marketing-purpose membership work in the same transaction. Replay reuses the
current permission event's rail identity; a work failure rolls the permission
write back. Local suppression does not wait for a provider and a provider response
cannot grant consent. Native legacy tester links refuse without an authoritative
legacy source; managed legacy links and localized unsubscribe responses remain.

Position 70 adds native fact storage without changing prior schema identities or
managed contracts. A trusted network-acceptance registration is distinct from a
captured receipt and from an observed delivery. Poll and admitted callback facts
share an atomic writer; exact observation replay is harmless, conflicting replay
refuses, terminal/suppression precedence is monotonic, and abandonment preserves
unknown delivery truth. A bounce or complaint uses the stored recipient fingerprint.

Newsletter work uses the existing outbox event identity, exact target namespace
and claim token. Its sidecar has no independent claim/lease/drainer; settlement
and rail acknowledgement are atomic and stale tokens do nothing. Only the existing
sync dispatch engine executes injected membership effects. Hosts must keep that
namespace out of a generic dispatcher. Registration does not grant consent and a
sync acknowledgement is never a delivery observation.

Native consent means registered P4 policy, authoritative native snapshot, durable
decision and active source-bound admin recipient. Managed frequency caps and
legacy contact-touching are excluded; evaluate is not a send-time fence. Missing
or unsafe storage throws before an effect. The [B3 expectation table](plans/oss-m04-communications-triggers.md#b3-native-stores)
names each changed public operation and its witnesses. Required-test registration
adds the native PG and reference-binding suites while retaining every old selector.

## Communications import compatibility

M04 P1 preserves the existing public communications contract while moving its
provider-agnostic algorithms to the platform package. Auth standard-webhook verification
keeps its stream-only body reader and millisecond clock; the maintained HTTP mail provider keeps its own
signature dialect and mapping in unchanged reference source. The generic HTTP hex-HMAC reader keeps its inclusive
1 MiB byte cap and parsed-body fallback; it does not replace either verifier.
The package transport contract and capture keep raw outcome/projection distinctions;
reference transport responses keep omitted fields,
headers/tags and sink/drop handling. Token purpose sets, receipt conflicts,
three-404 reconciliation abandonment and send/ledger ordering remain unchanged.
Browser-used renderer and preview values remain local. See the
[communications owner](../../src/domains/communications/README.md#packaged-server-algorithms).

## Neutral marketing sync

The development-preview communications entries expose the same 14 type-only
marketing-sync declarations in
[`marketingSync.ts`](../../packages/platform/src/communications/contracts/marketingSync.ts).
The three families have four operations: `profile.sync`, `consent.read`,
`erasure.request` and `erasure.read`. Capabilities bind an account, environment,
namespace, mapping version and audience. Unsupported scope refuses honestly;
verification remains pending until the applicable account evidence is admitted.
This contract supplies no provider implementation or activation.

The private construction mapper resolves opaque subjects and owned targets.
Brands supplement schema, binding, audience, subject, case and journal checks;
a cast or deserialized receipt grants no authority. Admission saves validated,
immutable effect evidence before dispatch and rechecks generation and tombstones
after awaits. Profile sync changes owned scalar data only. Current-state consent
readback has bounded coverage and source-bound negative facts; account-wide
facts retain that scope and audience denials cannot become global. Remote
subscribed state never grants local consent. Positive writes are deferred.

Replay identity is `(binding, operation, subjectReference, requestId)` with all
four binding coordinates. Generation is a separate stale fence. A current
new-generation call with the same effect replays without dispatch; its wrapper
echoes the call and its receipt retains the original request. Changed effect
fields under that key refuse `invalid_request`. Unresolved admission or partial
persistence fences new keys too. Cooling is durable and a failed cooldown write
quarantines dispatch; public retry delays are finite positive seconds.

Each operation has a closed result union. Mutation accepted means admitted
intent; acknowledged means provider acceptance. Neither means erasure completed.
Only fresh, authorized `erasure.read` with authenticated provider-read evidence
can complete the original bounded deletion. Ordinary 404, empty search, elapsed
time and receipt replay cannot. Completion never removes the subject tombstone.
Existing marketing ports and their observations and the existing
`NewsletterSyncProviderPort` remain unchanged. A refusal-only newsletter bridge
is planned in the later adapter PR. The [A1 ledger](plans/oss-a1-communications-adapters.md)
records the offline synthetic proof and remaining delivery gates.
