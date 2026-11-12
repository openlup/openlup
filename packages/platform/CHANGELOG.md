# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.39.0]

- Publishable on the npm `latest` dist-tag as `0.39.0`, from tag
  `openlup-platform-v0.39.0`.

- Add service-only checkout recovery snapshots, nullable order lineage, capability-gated expired inspection and an adopter-owned content validation fence. Inspection grants no payment authority and creates no replacement; renewal orders refuse.

Migration: Apply the additive native-store forward before composing the new readers. Existing lineage remains null. The self-FKs restrict deletion, and each immediate predecessor can have one replacement.

- @openlup/platform size growth: Inspection, lineage readers and the validation policy fit the inherited package limits; no cap adjustment is required.

- Add safety-first expired initial checkout recreation with frozen commercial validation, one permanent linked replacement, source-payment checks at first runtime admission, native purchase compensation and a shared adopter content fence. A replacement initial subscription gets a new provisional declaration; renewal cycles refuse. Native payment evidence qualification is limited to the sandbox owner; real-provider paths retain their named refusal.

Migration: Apply the additive service-only preparation forward after the recovery-lineage forward. No history is backfilled and no predecessor or live subscription is reopened. Hosts bind authority, quote extensions and a transaction-scoped sandbox runtime.

- @openlup/platform size growth: The packed cap is 3,023,741 B, adding 2% to the hosted 2,964,451 B measure; the approved unpacked, code/documentation and file-count limits are retained.

- Add configured checkout reminder waves with distinct live links, atomic event/token capture, recent-payment suppression and confirmed first-send evidence before the final wave.
- Add reservation-backed one-time checkout expiry, provisional initial-checkout abandonment and idempotent expired-notice reconciliation. Live subscriptions and renewal-cycle checkout recovery remain excluded.
- Add lazy scheduled-job and authenticated HTTP composition plus a recovery-specific confirmed-send receipt adapter; other mail paths retain their behavior. Host schedules, pages, browser journeys and expired-order recreation require separate composition.

- Fix a defect: an expired-checkout notice must not carry a link that is already expired; emit the same notice without a token when its recovery deadline has elapsed.

- Package size: code measures 2,338,375 gzip bytes against its prior 2,336,415-byte cap (+1,960 B), retaining the reviewed cap of 2,385,143 B (measured × 1.02, rounded up). Documentation measures 80,526 gzip bytes and fits the retained 0.38.0 cap of 81,230 B. Tarball, unpacked and file caps are unchanged.

Migration: Apply the complete platform chain through `20261110100000_checkout_recovery_waves.sql`. The widened order-status CHECK retains `NOT VALID` and does not revalidate historical rows. New service entry points use closed execution grants; existing entry-point headers and ACLs remain unchanged. Supply a distinct delivery profile and explicit host timing, lease, batch and copy configuration before enabling a job.

- Add owned account history, customer profile edits and acknowledged invoice correction requests. Profile replay uses recorded event keys and returns current state; its write and event append remain separate commits. Correction request keys are stored without deduplication.
- Add an explicit account-event privacy contributor and exact-row finite transfer classification. Event payloads may contain personal data; identity field clearing does not erase them. Export reports unavailable coverage. Erasure requires a configured reader and an explicit retain assessment; the retention receipt preserves payloads even when that reader reports unavailable export coverage. Missing reader or unresolved disposition refuses erasure.

- Package inventory includes the account-event source, SQL and guidance; the larger merged package caps are retained.

Migration:

Install the complete selected native prefix through `20261110120000_customer_account_events.sql`, bind the authenticated principal/client scope and validation policy, and register the privacy contributor. Saved addresses, billing profiles and starter editors remain separate work.

- Add signed-in checkout recovery start and continuation-cookie buyer payment links. Customer issuance preserves earlier links; buyer mail atomically queues one token and event per configured order bucket. Renewal-cycle orders retain separate recovery.
- Elapsed deadlines return the existing refusal or account/checkout fallback without a dead link. Apply the complete native migration chain before selecting these ports.
- Account navigation, HTTP registration, transactional transport and the embedded-browser control remain host bindings.
- Package inventory grows by nine files for the customer entry points and SQL projection; inherited package caps are retained.

- Add a private customer address book with owned read/save/canonical-reuse/default/delete ports, existing account events and explicit privacy/finite-transfer coverage. Subscription usage pointers support active/paused deletion refusal; saved-address selection and preference consumption remain separate.

Migration:

Install the full selected native catalogue through `20261110190000_customer_saved_addresses.sql`. Select `shipping` and host validation/copy/readers explicitly. Clear, write and event append remain separate commits; replay reads current state. Foreign/missing entity deletion remains a zero-row acknowledgement. The saved-address privacy owner erases saved rows; account-event retention and immutable destination ownership remain separate.

The documentation cap adds 2% headroom for the new guide footprint; packed, unpacked, code and file caps and the released baseline are retained.

- Fence provider-command initiation against both native and operator parcel cancellation with a shared/exclusive transactional advisory gate. Exclude cancelled parcels before the claim limit and recheck after locking, preserving queued records and live-parcel ordering, replay and submission during address changes.

Migration:

Install the complete selected native prefix through `20261110155000_fulfillment_parcel_status_fence.sql`, including its operator-transaction predecessor. Both cancellations take the dedicated parcel gate exclusively; enqueue, claim and submission share it. Enqueue retains its original parcel lock; claim and submission add none. Cancelled parcels refuse enqueue/submission with the existing command-fence conflict, and claim skips them. Function headers, owner and ACL remain unchanged. The locks cover ledger transitions, not the provider call; cancellation keeps its existing in-flight-effect guards. Outcome recording and provider behavior are unchanged.

The two cancellation routines and provider-command enqueue, claim and submission require READ COMMITTED isolation.

- Allow a preprovisioned Commerce operator with active human admin membership and no control row to resolve for OMS commands. Preserve the existing active machine-control route, SQL STABLE invoker header and ACL.

Migration:

Install the complete selected native prefix through `20261110160000_oms_human_operator_admission.sql`. The owner must provision one Commerce row per human admin and never delete it; withdraw authority by revoking membership. The existing creator ON DELETE SET NULL hazard remains. Hosts enforce human-admin admission and resolve before every command and replay. Starter route binding is separate.

- The documentation cap includes 2% headroom over the merged measurement. Other caps and the released baseline are retained.

- Unpaid operator cancellation now serializes with payment attempts and truth,
  refuses unresolved or moved money, records one audit and releases exactly the
  order's held purchase reservations. Late captures retain operator review.
- Manual external-refund marking records paid-to-refunded status without a
  provider call or refund notification/accounting reversal event. Genuine refund
  sources retain their duties; active subscriptions remain unchanged.

Migration: Apply the complete native catalogue through
`20261110200000_operator_order_commands.sql` before using these command semantics.
Existing function headers and privileges remain unchanged; private attempt reads
use a bounded owned command rather than additional table grants.

- Package size: documentation measured 83,296 B against an 83,177 B cap
  (+119 B); the documentation cap is now 84,962 B, including 2% headroom.
  The whole-tarball packed cap is unchanged.

Manual refund marks retain non-object order metadata under `previousMetadata`
and always record the manual source explicitly.

- Add the active-human operator order-payment-link handler and closed PostgreSQL store. Operator issuance records admission, revokes previous same-order checkout links, mints and optionally queues recovery mail, then records its outcome. Customer/service issuance and payment-case recovery keep their existing behavior.
- Configure operator lifetime and recovery window explicitly. Copy returns the token; email reports queued only after per-token durable handoff. Elapsed deadlines and renewal-cycle orders refuse without minting.
- The shared expiry-policy factory accepts an optional recovery window; existing callers keep its current default. Apply the complete native migration chain before selecting the new store. Operator UI, host registration and expired-order recreation remain separate.

Add explicit native operator replacement and complete parcel cancellation with exact per-parcel reservation generations, frozen preparation contact and destination, durable provider-cancel evidence, cancellation-event suppression and latest-parcel OMS reads. Legacy parcels without recorded reservations cancel with an explicit zero-release disposition; provider-confirmed paid cancellation refuses when recorded order mode is absent. Replacement preparation retains the original selection references and pickup-point provider. Ordinary cancellation refuses existing permanent dispatch evidence and accepted, submitting or uncertain provider commands under the parcel lock; this does not fence a later command enqueue. Neither journey settles a refund or confirms replacement arrival.

Migration: Apply the complete appended native catalogue before selecting these callbacks. To opt in, compose `{ ...createNativeUnsupportedFulfillmentPorts(), ...createPostgresFulfillmentOperatorPort(executor, { providerRef, stockSourceKey }) }` in place of the unsupported replacement/cancellation callbacks; keep host authentication and authorization. Supply `createPostgresParcelReservationConsumption(executor)` to the existing `markProviderStockConsumed` effect composition for exact parcel reservation consumption. Existing transaction lanes remain structurally compatible. Handle the cancellation response's added reservation count/disposition, and keep legacy manual stock correction and unknown-mode cancellation outside this path. Hosts retaining the unsupported factory need no callback change.

- @openlup/platform size growth: Native operator transactions add exact parcel associations, reservation generations, durable receipts and provider observations to the package. The transactions and dispatch guards fit the existing unpacked, packed, code, documentation and file-count limits.

- Native parcel preparation captures a private, minimal recipient and delivery-selection snapshot alongside the immutable destination. Dispatch evidence and public commerce projections do not expose that snapshot.
- The fulfillment privacy contributor exports those contacts and retained erasure markers through the existing personal-data workflow. It erases the contact payload while retaining a payload-free marker, with an explicit pseudonymous retention disposition, that prevents legacy inference from recreating it. Native retained-store transfer carries the snapshot and erasure marker with its parcel.
- Legacy contact resolution preserves canonical-override fences, validates the destination and freezes the inferred contact atomically. Replacement creation remains a separate capability.
- Preserve the selection's provider reference and the pickup point's provider in both native capture and bounded legacy inference. Ordinary preparation reuses the first contact and selection after profile defaults change, including while a dispatch reference remains draft; equal repeats preserve the capture time. Erasure cannot recreate the payload. Existing explicit dispatch-context edits remain available, while private contact correction is outside this capability.

Migration: Apply the complete appended native catalogue before using native parcel preparation. Hosts composing personal-data operations must register `createFulfillmentParcelContactPrivacyContributor` from `@openlup/platform/identity` and require contributor ID `fulfillment-parcel-contacts`; retain the existing identity contributor and subscription erasure veto. The reference Node composition does this explicitly.

- @openlup/platform size growth: Private parcel contact capture, privacy and finite transfer fit the inherited package limits after integration; no cap adjustment is required.

Add an opt-in sized future-plan editor with complete unchanged-line price
agreements, changed-only quoting, host-owned need/exclusion/catalogue ports,
transactional fact equality and current SKU admission. Explicit accepted consent
binds classic subscriptions atomically; preview and abandonment keep classic.
Direct/reverse binding writes refuse. Renewal uses the stored merged agreements.
Public declarations are additive and require a minor package-set release.
This source preview supplies no sized acquisition, account UI or catalogue
publication-head fence and activates no deployment or release.

Selected catalogue evidence (including document revision/digest, physical size,
exclusions and stock) is retained in the preview ledger and compared by existing
SQL equality. The host rereads and compares it in the apply transaction; catalogue
rows are not locked, so concurrent catalogue publication remains the
publication-fence limit.

Migration: extend `assertCurrentFacts` to reread and compare its selected catalogue
facts argument on the supplied transaction connection. Recreate outstanding
sized previews after upgrading; older previews lack the catalogue evidence.

- Fixed timed auto-resume after a paid first order whose native shipment has been delivered. Historical paid cycles and completed activations no longer keep a finite pause open; next-cycle orders and unfinished renewal or activation work still block safely.

Migration: `20261109150000_subscription_auto_resume_paid_history.sql` replaces only `subscription_auto_resume_due(integer,timestamptz)`, preserving its remaining guards, event, monotonic cadence roll-forward, header, owner and execution privileges.

- A timed pause shifts the next cycle by the pause length and never brings it earlier. Auto-resume and the pause reminder use the stored window duration, with reminders clamped to the pause end and auto-resume clamped to execution time; manual customer resume is unchanged.

Migration: `20261110105000_subscription_pause_duration.sql` replaces only the timed auto-resume function and the pause-reminder producer, preserving their skip guards, headers, owners and execution privileges.

- Add one atomic, service-only checkout payment guidance read with exact token/attempt binding, captured-observation suppression, bounded correlated evidence and validation-only status composition. Generic sandbox refusals use Core derivation; method, operation and advice remain unknown. Real-provider paths retain their named refusal and existing payment-owner closure. Legacy status responses retain capability opt-in and fallback.

Migration: Apply the additive guidance forward after checkout recreation. No token writes, table, backfill, lifecycle change or existing-function replacement is included.

- @openlup/platform size growth: Guidance fits the inherited approved package limits, including the 4,211 code-file limit; no cap adjustment is required.

- Accept the native activation owner's `active` state and cover native-to-HTTP status projection on legacy and both qualified runtimes, including capability opt-in, strict legacy output, read fallback, revocation and activated checkout.

- Add the experimental native operator shipment command factory for atomic label evidence, exact reservation consumption at handoff and tracking chronology with server actor and durable replay evidence.
- Preserve earlier-only delivered replay through the arrival recorder, operator-authorized latest-operation reads and fail-soft accounting composition after handoff. Historical missing reservation sets return a named zero-consumption result; unattributed cross-order tracking references refuse with the conflicting order reference. The documented limits describe manual resolution.

Migration: Apply the complete native catalogue through
`20261110230000_operator_shipment_commands.sql` before selecting these stores.
Tracking-reference writes through `fulfillment_record_evidence` (including spine
`recordTracking` with an evidence channel) require explicit
`metadata.providerKind` and READ COMMITTED. Missing provider identity or another
isolation level refuses before writing; non-tracking evidence is unchanged.

Install the complete selected native catalogue through `20261110230000_operator_shipment_commands.sql`. Hosts retain administrator authorization, provider selection, duty policy and connection ownership. No operator UI or live carrier call is added.

- The approved packed-byte cap of 3,023,741 B is retained. The higher approved code-file cap of 4,211 is retained; its prior measurement was 4,128 files plus 2% headroom. The released baseline is unchanged.
- Tracking-reference writers require READ COMMITTED and an explicit provider namespace, including shared shipment evidence. Exact handoff receipts replay before any new status transition.

Label URLs are durable operator-only operation evidence, and the full label and
tracking requests retain raw provider payloads/events in private operator
receipts. Hosts authorize these reads and govern retention of records and
backup/transfer copies; there is no automatic expiry or purge. Do not forward
operation payloads to customer routes. Replay preserves original evidence.

- Return requests bind the authenticated customer to an owned order before
  command-key lookup. Fresh requests accept paid/fulfilled orders, with one line
  per item and quantity capped at the ordered quantity.
- New receipts normalize key/note whitespace, UUIDs, line order, SKU and
  disposition defaults. Historical receipts retain their stored fingerprint;
  historical NULL SKU means not recorded. Hosts declare a subset of stored reasons.
- Partial approval requires an amount. Approved/rejected decisions produce
  deduplicated intent events; request creation produces none. Receive, restock,
  provider refund and subscription lifecycle actions remain separate.

Migration: apply the complete native catalogue through
`20261110210000_return_request_decisions.sql`. Existing primitive headers and
privileges remain unchanged. Historical replay uses a bounded owned command;
there is no additional runtime SELECT grant on return lines.

Historical and canonical key aliases are resolved by operation type and stored
fingerprint version before creation. Unique matches replay their own request ID;
ambiguous matches refuse uniformly. A historical request cannot act as a decision
receipt through a suffixed key. Existing receipts are retained unchanged.

- Select an owned saved shipping or both-kind address for future subscription deliveries. Preserve nullable saved recipients, replay precedence and immutable claimed destinations. Newly typed addresses still require a recipient; a successful typed change clears the saved selection. Keep the existing typed destination reader and use the additive saved-aware reader for nullable saved snapshots. First parcel-contact capture preserves null saved recipients without substituting customer names or address labels; typed/legacy fallback is unchanged.
- Add scoped delivery/payment preferences, explicit server handlers and redacted checkout hints that remain unapplied. Fresh renewal metadata selects complete delivery preferences before an anchor fallback; payment instruments and cycle alignment remain unchanged.

Migration: install the complete native catalogue through `20261110240000_subscription_saved_address_selection.sql`. New closed routines grant EXECUTE only to service_role; raw table access is limited to client-ID absorption census. Register the explicit preference privacy contributor for export and subject erasure. Native finite transfer carries exact rows to qualified targets; managed-source nonempty preferences refuse without a typed path. Saved snapshots keep existing privacy boundaries; destination-row erasure and starter binding are not added.

- Package size: saved selection, private preference routines and server contracts add SQL and portable source. Crossed packed, unpacked and documentation budgets use measured contents with 2% headroom; code and file limits are retained, and the released baseline is unchanged.

- Add sandbox token payment and exact cookie-only inline retry on the existing intent and durable attempt owner. Token admission rechecks bearer ownership; inline admission requires the exact failed predecessor, failed intent and permitted method action. Transition/nonce/rail replay rotates the replacement cookie without redispatch, with safe polling when action readback lags. Both fresh paths reuse the injected first-purchase hold wrapper. Renewal cycles refuse; initial declarations remain eligible. Verified ingress retains settlement ownership and other rails keep their named native refusal.

Migration: Apply the additive checkout-attempt admission forward after atomic guidance. The single forward creates two service-only entry points without replacing existing functions or adding storage. Bind an explicit synthetic-method registry and purchase-context policy for inline retry; no method taxonomy is inferred from opaque references. Host routing and browser journeys remain separate.

- Add owned customer billing profile CRUD and strict request/handler binding, preserving separate default-clear/write/event failures and stored request identifiers without deduplication.
- Freeze buyer inputs on first native duty capture, including payment truth and retained sources collected by the sweep. The selected billing invoice store reads the component for later fiscal composition and validates installation. Existing owed duties are never backfilled on replay. Preserve line2 and source/profile/address references in additive public fields and provider projection. Profile edits leave existing invoice facts and issued bytes unchanged; later requests use the new profile.

Migration: install the complete native catalogue through `20261110270000_invoicing_duty_buyer_capture.sql`. Bind the selected billing invoice store and its frozen reader before fiscal composition. Register the explicit billing privacy contributor: editable profiles erase, invoice components retain under the invoicing owner. Finite native transfer carries exact rows to qualified targets. New routines grant EXECUTE only to service_role; raw access is limited to profile client-ID absorption census. Generic native duty capture now freezes buyer inputs by default; pre-existing duties and historical facts remain unchanged. Follow the first-duty buyer-capture migration guidance for recorded destinations, order-owned handoff shipments and capture-fault limits. No automatic checkout application, registry workflow, starter UI or fiscal provider qualification is added.

Package caps: code 2,513,518 B, documentation 92,404 B and 4,435 files retain the reviewed headroom for the crossed classes. Other limits and the released baseline remain unchanged.

Native invoicing freezes the lossless buyer component atomically when an original owed duty is first captured, including the payment-truth path. Selection keeps order facts, owned default/latest billing profile and address, then the marked shipping fallback, including the second address line and provenance. No opt-in or payment-side account-data binding is required.

Existing duties and documents never acquire a buyer component later. The selected billing invoice store reads the component for fiscal composition and validates installation; profile edits leave captured facts and issued bytes unchanged. Private access, invoice retention and exact native transfer remain under their existing owners.

Migration: install the complete native catalogue through `20261110270000_invoicing_duty_buyer_capture.sql`. Record the owned order destination before capture: missing data refuses with `commerce_destination_unavailable`. A handoff source must name a shipment owned by that order, or capture refuses with `customer_billing_shipment_mismatch`. Payment truth absorbs these as bounded retryable capture faults without rolling back money; the retained-source sweep marks the source `faulted` when its eight-attempt ceiling is reached. Correct the source while it remains retryable. After it is faulted, the sweep excludes it and there is no supported operator reset/requeue command; recording a destination alone does not resume it. Escalate for an invoicing-owned recovery procedure rather than changing or deleting ledger rows.

Compose `createCustomerBillingPrivacyContributor` with required ID `customer-billing` even without selecting the billing invoice store, as described in the identity privacy guidance. The Node reference host composes it alongside its identity, subscription and parcel-contact contributors. Editable profiles erase; frozen invoice buyers retain under the existing invoicing owner.

## [0.38.0]

- Publishable on the npm `latest` dist-tag as `0.38.0`, from tag
  `openlup-platform-v0.38.0`.

Checkout recovery links for one admitted purchase now coexist until expiry or
payment. Identical-hash replay and cross-order refusal remain unchanged. Pending
renewal-cycle orders refuse checkout issuance. Payment-case links still rotate,
with issuance serialized on the pending order; the separate actor issuer also
retains rotation. Install the complete native migration chain before using the
updated checkout issuer.

Add the opt-in classic package repricer and PostgreSQL preview/apply binding. Content-keyed one-use previews accept a separate apply key; future renewal terms retain accepted line pricing. Both quote and apply read the configured minimum base units. Apply the package-editor forward through the selected migration plan before composing native account reads or the editor. Hosts supply authenticated ownership, composition mapping and a promotion-free server-authoritative quote engine.

- Declare npm `keywords`, a `homepage` pointing at the package README in the
  source repository, and the issue tracker as `bugs`, so registry search and
  package pages lead to the documentation and to issue reports.

Replay a completed classic package-edit key before repricing or configuration reads, preserving its originally recorded result after a price change. Fresh commands still require a matching current quote.

- Export `./package.json`, so tooling and agents can read the installed
  version and metadata with `import.meta.resolve("@openlup/platform/package.json")` or
  a JSON import. It adds no code entry point.

Fence late retry case observations after lifecycle closure, including after a
later resume. Timed auto-resume now skips ineligible windows without failure,
rolls forward by whole cadences and records one system event; the lifecycle
messenger maps that event to the resumed confirmation.

Expose `createPostgresSubscriptionAutoResume` through `subscriptions` and trusted
`CycleRetryCadence.backoffHours` configuration through native retry stores and
bindings. Defaults and terminating failure-class behavior remain unchanged.
Install the complete native migration catalogue before selecting these entries.

Migration: Existing retry-store callers keep their one-argument construction and
24/72/168-hour defaults. To override timing, pass `{ backoffHours }` as the
store's second argument or `retryCadence` in the native binding's retry options.
Install the complete catalogue including the new timing overload first. Hosts
may then bind `createPostgresSubscriptionAutoResume(executor).run` to their
scheduler; construction schedules no work. No browser policy field is added.

- Add an explicitly selected native winback worker with subscription-wide send
  deduplication, configurable cancellation age and retention consent, failed-send
  retry and durable receipt recovery, including retained episode-key acceptances.

Migration: apply `20261106140000_subscriber_winback_policy.sql` through the
complete selected catalogue before composing `createPostgresSubscriptionWinback`.
Provide the existing delivery rail and localized account-link binding. Configure
`subscriber_winback_policy` explicitly; omitted fields retain consent required
and the inclusive 14-day / exclusive 120-day window. Account consent capture and
charge-confirmed reactivation remain host composition.

- Close recovery and unpaid obligations on explicit pause/cancellation. Add
  confirmed order-now/reactivation commands, trusted lifecycle timing terms and
  structured retention evidence through the existing subscription entries.

Migration: apply the lifecycle-closure forward before selecting these command
bindings. Hosts may provide `lifecycleTerms` and `retentionReasonCodes`; existing
SQL signatures retain their prior timing defaults. Send literal charge-timing
confirmation for order now/reactivation. Stored receipt replays keep their
accepted results; legacy survey strings remain supported.

Native subscription reminder production now applies configured eligibility before
consuming the renewal-day identity and retains the exact queued charge instant.
Pause notices use window identity and recheck resolution before delivery. At-risk
notices retain cause/day history for accepted deliveries and disabled templates.
Operator notices use distinct recipients, fresh-only eligibility and fenced claims.

The existing subscriptions entry gains optional notice timing/cap configuration
and an explicit operator binder. Hosts continue to own calendar labels, copy,
delivery-window estimation and recipient-bound rendering through the trusted binder.
Imported or uncorrelated starter history uses standard freshness and may miss an
early reminder. Real provider acceptance/idempotency remains a host prerequisite.

- Fix timed auto-resume remaining paused after its first paid order has been
  delivered. Historical fulfilled orders no longer block; in-flight orders and
  orders in the existing paid/fulfilling/fulfilled allowlist on the next date
  still prevent stacked deliveries. Cancelled pause-closure orders do not block.

Migration: apply `20261109113000_subscription_auto_resume_delivered_history.sql`
through the complete selected catalogue. The function header, privileges, other
eligibility guards, event identity and whole-cadence roll-forward are unchanged.

Add seven exact subscription edit levers through the existing preview/apply
binding, preserving individual line IDs, fixed-total mix, configured plan/portion
sizing, accepted recurring pricing and replay-first receipts. Reduced mode must
strictly reduce units; full restoration is permitted. Install the additive
exact-lever migration after the shared package editor. Host routes and portal
controls remain application composition.

These levers are opt-in and API-only; hosts supply routes and portal controls.

## [0.37.0]

- Publishable on the npm `latest` dist-tag as `0.37.0`, from tag
  `openlup-platform-v0.37.0`.

- @openlup/platform size growth: 987 shipped declaration maps contribute 227,397 packed bytes in an archive comparison, alongside the native commerce, account and fulfillment surfaces and their complete migration histories.

- Ship declaration maps that navigate to the packaged TypeScript sources,
  consumer-first installation guidance and release-tagged agent source citations.
- Allow Node `>=24` while
  retaining Node 24 for contributor verification. Pin exact package versions and
  upgrade the OpenLup set together.
- Add the installed package agent guide, checked subpath maturity table and
  compiled public-export wiring example. Raise artifact limits only for the
  measured declaration-map cost; no runtime, exports or SQL changes.

- Add the Node-only `openlup` application command-line tool and `verifyApp`
  for application-owned upgrade planning, diagnosis and verification. These
  tools preserve explicit host authority and do not activate an application.
- Include two later-phase preparation changes: derive native forward shapes
  from issued registry slots, and omit recognized inventory-admission busy
  rows from renewal batch results without masking other failures.
- Calculate the second-delivery renewal discount with exact integer arithmetic,
  preserving the promised product amount without floating-point rounding drift.
- Use the package quote engine for the starter's first-subscription offer and
  recheck its second-delivery promise against current terms, refusing a stale
  promise before checkout rather than accepting an outdated amount.

- Apply retry recovery effects only after payment truth confirms an applied
  captured settlement. Captures retained for review keep their evidence without
  advancing the renewal counter, restoring stock or recording paid recovery.
- Return `payment_failed` for non-paid recovery readback; the retry driver reports
  a row error for reconciliation. Exact evidence redelivery remains idempotent;
  genuinely paid recovery and its stored receipts retain their behavior.

Migration: install `20261106060000_subscription_retry_recovery_truth.sql` before selecting the updated retry
adapter. Treat a non-paid recovery result as unresolved payment evidence and
inspect its payment-truth review record; do not synthesize settlement or retry a
charge from that result. Existing paid recovery receipts continue to replay.

Historical recovery receipts are checked against payment truth before replay.
Previously misapplied counter or stock changes require reconciliation; this
forward preserves those historical rows instead of reversing them automatically.

- Package the complete canonical PostgreSQL migration histories, including
  qualified-v2 and restricted qualified-admin, with a generated drift-checked
  manifest. Add `createPlatformPostgresMigrationRunner` to `/migrations` for
  explicit installation/status through the existing executor without a checkout.
  The package factory requires an explicit installation selection; the repository
  legacy default and low-level runner API remain unchanged. Existing units
  keep their SQL bytes, ledger paths, hashes and order; no new forward is added.

Migration: fresh consumers select a qualified generation and provision its
existing PostgreSQL 16 role profile before calling apply. Install the optional
`pg` peer. Existing histories cannot change generation. Managed history and
application activation are unaffected.

- Add `runCommunicationsAdapterConformance` and its subject/evidence types to the
  existing communications entry for offline email and marketing-sync fixtures.
  Findings give a bounded fix/recheck; passing fixtures do not qualify a provider.

Add the opt-in PostgreSQL checkout recovery token port for trusted admitted-order
hosts. It supports principal-less contacts, creation-plus-24-hour expiry,
replay-safe issuance and initial subscription facts. Issuing a new link ends the
previous link of the same order.

- Isolate authenticated subscription pause and bundle command keys from system event keys using the existing principal-scoped command hash. New actor events and quotes carry principal-bound derivation provenance; unmarked rows at a derived key refuse as ambiguous rather than replaying.
- Reject supplied keys starting with `command:` at pause, bundle preview and bundle apply, including historical raw keys with that prefix. Non-reserved, unmarked legacy history replays only for the same owner and action, with matching accepted quote proof for bundles. Another customer action refuses; a raw system event is bypassed.
- Graduation, cadence normalization and dunning exhaustion preserve a legacy foreign event at their predictable key and select a prefixed system identity, so old customer keys cannot block or suppress system evidence.

Migration: apply the complete selected catalogue through `20261106050000_customer_command_key_isolation.sql` before serving customer commands. The forward adds nullable quote provenance and replaces function bodies while retaining existing privileges and history. It neither re-keys history nor backfills markers. Keep the matching package runtime for graduation collision handling; rolling back to earlier writers restores the old collision behavior.

- Add actor-owned account choices, grants and withdrawals for the independent
  newsletter and gifts-and-discounts marketing purposes, with durable provenance,
  suppression precedence and idempotent replay. Retain consent history and trusted
  sync target configuration through connected native-store capture and restore.
- Record withdrawals locally even when the email or sync target is unusable;
  successful withdrawals can return a null `workId`. Provider sync requires a
  usable recipient and enabled target. Replay never backfills deferred work.

Migration: apply `20261101232000_customer_account_consents.sql` through the
selected native migration sequence before using these actor routines. Use the
owner-documented unsynced-denial query to inspect withdrawals without work;
reconcile current choices before provider action. Existing actor setters retain
their served behavior. This introduces no provider retry worker or erasure path.

- Add the host-only `createPostgresContactClientRegistrar` identity factory for
  guest checkout contact resolution. Exact email matching converges concurrent
  calls on one client; optional profile defaults and journey facts refresh only
  unlinked contacts. Linked rows remain untouched, and erased shells refuse
  while a freed address starts a fresh contact. Hosts own requester quotas,
  guest response shaping and contact retention.

- Add the experimental `fulfillment/native` `createNativeFulfillmentBinding` locked dispatch-preparation binding
  with host-owned contribution composition and an explicit, default-off captured fulfillment dispatch adapter. Captures
  are offline synthetic evidence, with exact preparation matching and replay;
  they do not qualify a provider or record physical delivery. Native commerce
  list/detail reads retain their existing refusal.

### Native account reads

- Extend account-support with explicit native reads for owned order persistence,
  subscription evidence, existing actor snapshots and newsletter withdrawal.
  Missing saved profile/events sources refuse by section. Historical summaries
  retain recorded amounts while detail without captured money refuses. Paid
  activation gaps appear on owned orders, without invented subscriptions.
  Consent choices/grants use the separate consent lifecycle; saved flags
  never establish evaluator consent.

### Native OMS, returns and support store bindings

Expose the existing PostgreSQL OMS control, reduced control-plane, delivered
system-hold recovery, returns and customer-support journey stores through explicit
platform subpaths. Reference imports delegate to the same factories and error
constructors. Portable support read schemas have a separate browser-safe entry;
the existing contracts entry remains type-only. Existing SQL, replay and named
refusal boundaries are preserved. No rich OMS projection or diagnostic store is
added.

Migration: Existing source imports remain thin facades. Installed consumers select
`commerce/server/postgres`, `account-support/postgres` and, for browser validation,
`account-support/read-contracts`. Supply the existing restricted runtime executor
or connection and trusted operator context; select the optional `pg` peer for
connection-owning stores. No SQL or data migration is added. Rich OMS projections
and the existing unsupported commands retain their refusals.

Expose the existing PostgreSQL bundle admin write store, shared marshalling and error constructors through the catalog entry. Reference facades preserve constructor identity and existing SQLSTATE mapping. The native binding now encodes all three bundle JSON parameters for pg, restoring composition writes while preserving JSON values and SQL null defaults. Shared managed marshalling, SQL, roles and authorization remain unchanged.

- Add `commerce/server/native-checkout` for restricted-runtime native draft
  persistence. It preserves quote and draft money snapshots, replays one durable
  receipt and refuses changed input without superseding or paying the order.
  Existing native money-shape limits remain; no SQL or managed behavior changes.

Add experimental `invoicing/postgres`: explicitly selected captured sandbox
provider, append-only non-fiscal PDFs, and principal-owned native invoice
history and download tickets. Preserve correction lineage, stored currency,
replay and missing-evidence refusals; managed behaviour remains unchanged.

Native order drafts accept
configured threshold delivery after product discounts
and serialize acquisition capacity through a narrow runtime lock helper. The
shipping entry adds a quote presentation helper for paid, free and stale terms;
the local invoice constructor includes effective delivery as a separate line.
Apply the complete native migration chain before selecting the new checkout
behavior. Managed hosts and provider activation are unchanged.

Add native order, subscription and shipment destination authority through
`commerce/server/destinations` and the bounded operator address branch. Exact
replay retains applicability; changed input and stale template versions refuse.
Dispatch-owned parcels keep their frozen address with `applied_from_next_parcel`.
The subscription event and deduplicated confirmation outbox commit atomically;
mail dispatch stays host-bound. Private address and binding rows join bounded
store transfer. No saved address book, destination privacy export/erasure, money
or delivery-alignment change. Hosts must display next-parcel applicability and
install the complete catalogue before composing this experimental entry.

Migration: Install the complete native catalogue before binding
`createPostgresDestinationPort`. Native operator address calls previously
returned the authority-unavailable refusal; they now use the bounded address
routine. Handle `applied_from_next_parcel` explicitly and show that the frozen
parcel retains its old destination. Do not treat it as fully applied current
delivery. The managed result type is unchanged. Hosts must bind checkout and
authoritative shipment reads themselves; no saved-address or mail route is added.

- Native lifecycle delivery now routes operator payment-repair notices through
  their latest customer failure template, requeues transient delivery failures
  and bounds recovered history by current case truth and configurable recency.
- Optional dispatch policy configures claim leases, attempts and retry backoff.
  Recovered policy configures the inclusive window. The run result includes
  requeued notices. Accepted receipts retain acknowledgement recovery.

Migration: Hosts may supply a failed delivery receipt with `retryable: false`
for a final rejection. An omitted disposition means transient. Exceptions retain
the sending lease. Read the lifecycle binding policy before selecting a host.

Native event and reminder policy refusals now terminally complete the original
source. Missing recipients, disabled controls and refused consent remain terminal
after policy changes, restart and connected store transfer. These records do not
assert delivery or change the dunning flow or transactional delivery receipts.

Add native purchase holds through `createPostgresPurchaseReservationPort`: atomic
item batches, keyed release and bounded expiry on the existing reservation tables.
`createPostgresAbandonedCheckoutCompensationPort` cancels an abandoned checkout
and releases its purchase holds atomically without a runtime ledger grant.
Changed keyed input and elapsed initial expiry refuse. Existing ATP, renewal,
stock wait and retry count these hard holds. Lots, locations, balance counters
and movement history remain outside this slice. Hosts bind the checkout seam
and schedule expiry; dedicated promotion cancellation remains unbound. References
may identify people; hosts should use opaque values. No erasure path is provided.
Managed behavior is unchanged. No npm release or automatic host wiring is included.

Fresh stock writes retain shared admission, READ COMMITTED isolation and a
transaction-local 50 ms lock bound. Busy admission remains a named persistence
refusal; committed replay needs no fresh admission. No automatic retry is added.

- Expose native subscription composition, retry, delivery admission and typed
  settlement adapters through the subscriptions entry. Hosts retain readiness,
  the population lease, payment-owner readback and transaction selection.
- Replay matching terminal renewal history before current due eligibility,
  including after cancellation, while refusing changed frozen input and new
  cancelled work. Native retry, recovery-token and stock-wait history join the
  bounded connected-store transfer profile.
- Include durable activation and paid-cycle correlation when selecting normal-due
  stock-wait work for the renewal codec.
- Freeze the immutable destination inside the claim transaction. The original
  zero-shipping registration retains its typed marker; the opt-in retained-terms
  path described below adds cycle shipping quotes.
- Enter shared stock admission inline inside the six existing invoker renewal
  and stock-wait routines, with the helper's busy and isolation codes. Grants
  stay unchanged; custom invoker runtimes need nothing new. Reservation SQL and
  raw errors stay unchanged. The shipment destination view is nonmutating and
  does not acquire dispatch locks.

Expose request-scoped PostgreSQL price authority history reads through the existing commerce server entry. Characterize the unchanged native promotion reader and document its device-evidence and mirror-family limits.

- Add opt-in `createPostgresCommerceQuoteCatalogReadPort` in the existing catalog
  entry. It reuses strict envelopes, guards current payload revision facts and
  requires host schema, semantic identity and digest verification. Bounded
  scans refuse incomplete authority without partial success; current-direct
  consistency does not qualify a publication head or publication-wide snapshot.

Retain renewal delivery and acquisition terms through the purchase attachment.
Second delivery honours the promised price; an unedited subscription graduates
before delivery three, while add-ons and customer-selected normal cadences remain.
Shipping is paid below and free at or above the retained threshold after product
discounts. Frozen retry/terminal history takes precedence over current terms.

Readers of `shippingQuoteRef` can now receive the `retained_shipping` marker because its output union gained a member, and purchase-facts `shippingAmountMinor` widened from `0` to `number`.

Migration: install the selected account-choice forward and its prior SQL approval
before selecting the new reader/writer. Supply a single-connection transaction
runner to both the renewal store and settlement port for retained snapshots.
The original zero-shipping registration and existing native-v1 wires remain valid.
These are explicit preview seams; no host switch, real mandate or npm release is
performed. Existing account-choice history and suppression retain their semantics.

- Add the sandbox-only PostgreSQL payment simulator with durable active-attempt
  fencing and server-observation verification. Browser returns cannot pay an
  order. Captures after cancellation remain terminal operator-review truth;
  no order reopen, refund, real provider store or schedule-rule change is added.
  Requires the complete native chain through the sandbox-attempt forward.
- Preserve microseconds and canonical UTC timestamp identity across database
  sessions for simulator replay, its payment truth and native renewal snapshots.
  Invalid purchase timestamp facts continue to reject asynchronously.

- Preserve renewal authorization for existing terms without a method-state row.
  Purchased subscriptions still receive method state atomically with their
  terms, and explicit unhealthy method states refuse before payment execution.
