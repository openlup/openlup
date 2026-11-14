# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.41.0]

- Publishable on the npm `latest` dist-tag as `0.41.0`, from tag
  `openlup-platform-v0.41.0`.

- Add the experimental `payments/testing` subpath with the existing conformance runner and a provider-neutral scripted transport fake. Optional safety fixtures exercise capability/refusal parity, network ambiguity, signed webhook replay, invalid money, partial amounts and chargebacks without live access. Existing adapter behavior and imports remain unchanged.
- Reserve the measured platform artifact budget for the next payments implementation part; individual feature rows share these caps.
Migration: `runPaymentAdapterConformance` now takes `readonly PaymentAdapterTestSubject[]`. That named type is the previous subject with its `verification` fixtures plus an optional `safety` member, so existing callers compile and run unchanged and need no action.

## [0.40.0]

- Publishable on the npm `latest` dist-tag as `0.40.0`, from tag
  `openlup-platform-v0.40.0`.

- Add experimental neutral ecommerce-event contracts, retained paid-time source snapshots and explicit PostgreSQL projection through the existing outbox. Paid orders, nonfinancial refund status, checkout qualification and subscription lifecycle facts keep source identities separate from delivery attempts.
- Extend `@openlup/platform/communications/klaviyo` with separately qualified events using the account's existing pacing and cooldown. Provider acceptance remains distinct from ingestion; pending scope, historical import and stale authority refuse before HTTP.
- Ship offline wiring recipes for transactional delivery, marketing refusals and frozen event replay. Local fixtures do not qualify provider accounts or activate any route, job or flow.

Migration: apply the complete packaged migration chain before composing the new projection. Select the fixed live cutoff, account/environment and mapping explicitly; register actual privacy/retention policy and preserve pending duties during recovery. Existing installations do not export events automatically.

Require the complete declared scope set for the opt-in marketing adapter's consent-push capability, including profile write permission. Missing evidence remains verification-pending before provider HTTP. Preserve the existing transport outcome contract and clarify host retry, delivery and adapter-selection responsibilities.

- Stop shipping `AGENT_CONTEXT.md`. Use core's `openlup-context` and the reader guide shipped in `@openlup/core`.

## [0.39.0]

- Publishable on the npm `latest` dist-tag as `0.39.0`, from tag
  `openlup-platform-v0.39.0`.

- Add service-only checkout recovery snapshots, nullable order lineage, capability-gated expired inspection and an adopter-owned content validation fence. Inspection grants no payment authority and creates no replacement; renewal orders refuse.

Migration: Apply the additive native-store forward before composing the new readers. Existing lineage remains null. The self-FKs restrict deletion, and each immediate predecessor can have one replacement.

- @openlup/platform size growth: Inspection, lineage readers and the validation policy fit the inherited package limits; no cap adjustment is required.

- Add safety-first expired initial checkout recreation with frozen commercial validation, one permanent linked replacement, source-payment checks at first runtime admission, native purchase compensation and a shared adopter content fence. A replacement initial subscription gets a new provisional declaration; renewal cycles refuse. Native payment evidence qualification is limited to the sandbox owner; real-provider paths retain their named refusal.

Migration: Apply the complete catalogue through `20261110280000_checkout_recovery_buyer_snapshot.sql`, which preserves snapshot absence during preparation. No history is backfilled and no predecessor or live subscription is reopened. Hosts bind authority, quote extensions and a transaction-scoped sandbox runtime.

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

- Fix expired checkout recreation creating an empty invoice buyer snapshot when the source has none. Preparation now preserves absence so first-duty capture selects the owned billing profile/address, then the marked shipping fallback. Recorded snapshots, including explicit empty objects, remain unchanged; capture replay and later profile edits preserve frozen buyer facts.

Migration: Apply the complete native catalogue through `20261110280000_checkout_recovery_buyer_snapshot.sql`. The forward replaces only the preparation function; it adds no backfill and changes no buyer selector, lineage, payment authority or grants.

### Fixed

- The migration runner refused its own ledger on PostgreSQL 16.16, 17.12 and later minors, which set attribute options on new columns. It now accepts only the numeric `pg_attver` version marker and still refuses any other attribute option.

### Known issue in 0.31.0 through 0.38.0

- In 0.31.0 through 0.38.0, fresh installations and restored databases on those PostgreSQL minors are refused by the migration runner. Upgrade to this release before installing or restoring.
