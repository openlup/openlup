# Starter limits

Compare package composition, source references and the application starter before
choosing an evaluation path. Use the starter tables below to recognize its
refusals while running it.

## Evaluation boundaries

| Path | What you can evaluate | Boundary |
| --- | --- | --- |
| npm packages | Selected engines and server services in your application | Pin matching exact versions; supply adapters and host composition. Follow [installation](../start/README.md#install-the-packages). |
| Portable PostgreSQL primitives | Database ports, migrations and recovery operations | Supply application composition; see the payment boundaries below and the [database recipe](../how-to/operate/connect-postgresql.md). |
| Default source reference | Static catalogue and item pages, plus health | GET/HEAD only; checkout, subscriptions, admin, API/BFF, cron and mutations are refused. |
| Opt-in subscription reference | Recurring-item purchase, captured payment, confirmed email sign-in, owned order/subscription reads and renewal-date changes | Owned disposable local database/authentication services and Node host; synthetic data and a captured mailbox, with no external provider calls. |
| Application starter | Native actions bound to a local demonstration database | Sandbox payments and private message capture; no hosted-database installation recipe. |

The opt-in subscription reference does not demonstrate automatic renewals,
fulfillment, failed-renewal recovery or the complete late-delivery journey.
A renewal date is a planned charge date, not a delivery promise. Follow its
[local evaluation recipe](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/docs/platform/SUBSCRIPTION_REFERENCE.md)
for setup and buyer/account verification.

To evaluate a source reference, choose an immutable release tag and follow that
revision's README and release notes, including its toolchain and test
prerequisites. A source build does not start a complete commerce application.
See the [install support policy](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/.github/INSTALL_SUPPORT_POLICY.md)
for the installation boundary.

## Pure contract limits

Core's catalogue identifier schemas validate bounded shapes. They do not prove
that a product, SKU, variant or slug exists; your catalogue reader owns
membership and current product facts.

`calculateInventoryAtp` evaluates supplied stock, reservations, unavailable
quantities, safety stock and lot facts. It selects a location when the request
can be fulfilled there and can return review-required or unsupported results.
It neither reads stock nor reserves it. Its no-split policy refuses split
shipment requests with `split_shipment_unsupported`.

Company-identity contracts describe lookup requests, per-source outcomes and
verification levels. Your host selects identifier kinds, supplies the lookup
adapter and decides whether its trust level meets the purpose. Schema validation
queries no registry and approves no seller.

`StandardSchemaV1` is a structural schema interface that keeps browser consumers
independent of a validation-library runtime. The selected schema and its
consumer still own validation behavior.

Risk evaluation matches supplied signals against deterministic rules and returns
score, severity, reasons and mode-dependent enforcement facts. Your host selects
shadow, review or enforcement policy; a result alone authorizes no order or payment.

## Store composition

Starting the starter host without a runtime database connection leaves its
native actions unbound. Its lifecycle supplies that connection for the local
demonstration database; configuration health alone does not establish live
operations. The [local image quickstart](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/deploy/neutral-store/README.md)
does not establish rollback after a schema or package upgrade. Follow the
[database upgrade procedure](../upgrade/database-migrations.md) for that boundary.

Portable payment execution is sandbox-only; real-money execution uses the
managed rail. Provider-neutral contracts do not supply every payment rail.
Self-hosting and provider integrations require application composition:
[compose the host](../how-to/operate/self-host.md) and
[bind a provider adapter](../how-to/extend/provider-adapters.md).
Adapter source does not activate an integration or certify a live provider account.

Native account reads need explicit host sources. See
[account composition](../how-to/build/account-and-support.md#bind-reads-to-the-customer)
for missing-section refusals, newsletter consent, historical order money and
paid orders awaiting subscription activation.

## Starter refusal responses

The app’s `/limits` and `/ograniczenia` pages and unavailable-action buttons use the
[canonical limits table](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/examples/neutral-store/shared/limits.ts).
A visible refusal button displays the code and explanation locally; it does not submit an operation.
API refusals return an object such as `{"ok":false,"code":"host_binding_required"}`.
Unknown operations return HTTP 404; other action refusals normally return HTTP 409 unless the handler supplies another status.
Codes beginning `starter_` identify application limits, rather than additional exported package errors.
In the tables, “—” means the boundary has no dedicated refusal code.

## Catalogue and runtime limits

| Action | What happens | Refusal code |
| --- | --- | --- |
| Edit live products, SKUs, price lists, price entries or promotions | These are demonstration seed data; there is no runtime editor. Bundle and catalogue drafts have separate operator editors. | `starter_promotion_write_unavailable` |
| Enter checkout promotion codes | Nonempty promotion-code input is rejected. | `starter_promotion_codes_unsupported` |
| Publish a catalogue draft | Draft authoring does not publish the live catalogue. The visible action refuses. | `starter_catalog_publication_unavailable` |
| Purchase an activated bundle | Activation does not make a bundle available to this storefront or checkout. | —; no purchase control |
| Use lot traceability, locations or stock movements | The starter supplies none of these inventory facilities. The limits-page action refuses. | `starter_inventory_traceability_unavailable` |
| Run the starter against a hosted database | The supplied installation is a local demonstration database recipe. It provides no hosted-database setup. | —; no hosted installation recipe |
| Seed without the installed bootstrap | Seeding stops before application startup. | `starter_installation_binding_required` |
| Seed through a runtime login or role | Seeding stops rather than writing through the runtime identity. | `starter_seed_runtime_role_forbidden` |
| Seed through a different install identity | Both the login and current role must match the install identity. | `starter_seed_install_role_required` |
| Seed an unmarked database | The demonstration marker is required; the bootstrap also refuses a pre-existing unmarked database. | `starter_seed_demonstration_database_required` |
| Keep demonstration sessions across a restart | Sessions live in the current process, have a bounded lifetime and disappear on restart. Issuance stops when the session store is full. | `starter_session_capacity_exceeded` at capacity |
| Call an unbound operation | A missing host binding refuses. Customer and operator admission may refuse first. | `host_binding_required`; `customer_session_required` or `operator_required` before admission |

## Subscription editors

| Action | What happens | Refusal code |
| --- | --- | --- |
| Resize from demand, plan length or portion | Demand-driven resizing is unconfigured. Ordinary classic plan and sized cadence choices preserve explicit quantities. | `starter_subscription_resize_unconfigured` |
| Swap items, edit individual extras or change a fixed-total base mix | Use the customer-session API; the portal has no buttons for these edits. | —; no portal controls |
| Start a size-aware purchase | New purchases start classic. Size-aware servicing requires a reviewed and explicitly accepted opt-in. The visible acquisition action refuses. | `starter_sized_acquisition_unavailable` |
| Require a publication-version or offer-membership fence for sized edits | Apply checks current active and subscription-sellable state, but does not serialize catalogue publication or enforce those publication fences. The visible fence action refuses. | `starter_sized_publication_fence_unavailable` |
| Edit a subscription without base lines or a price context | The editor reports a blocked template; it does not invent a fallback. | `starter_subscription_template_unavailable` |
| Opt in to sized servicing during a fixed introductory phase | The edit is rejected until the introductory restrictions allow it. | `subscription_edit_invalid_intro_fixed` |

Captured sized-renewal receipts include a parcel note only when frozen
quantities, physical sizes and cadence are provable and the subscription is
still sized when sent. Classic, acquisition and unprovable parcels omit it.

## Partner intake and reviews

| Action | What happens | Refusal code |
| --- | --- | --- |
| Use a generic contact form | Support is static, with an optional configured contact address and account link. Partner inquiry is the durable intake form. | —; no generic contact form |
| Submit or read a review without its order-review grant | An account session alone does not authorize the review. | `access_grant_unavailable` for a missing grant; invalid grants return the native review reason |
| Upload review media | The visible action refuses; a storage binding is required. | `host_binding_required` |
| Submit research or import normalized orders | Research-case authority and a complete trusted order-import binding are absent. Import admission requires an operator first. There is no real marketplace connector. | `host_binding_required` |
| Use intake behind a proxy as if each visitor had a separate requester quota | The host hashes its socket peer and ignores forwarding headers, so visitors behind a proxy share that requester identity. | —; shared requester quota |
| Treat partner inquiry as consent, conversion or a privacy workflow | Inquiry submission does not grant marketing consent or convert a customer. Partner privacy export/erasure is not supplied. | —; intake only |
| Run risk screening | Risk is disabled; the visible action refuses. | `starter_risk_disabled` |

Configured support appears as plain text with an account link; missing contact
configuration is stated explicitly. Partner submission, operator list/transition
and review read/submit/list/moderation need the runtime database connection.

Intake enforces bounded requester and email quotas over a rolling window.
Replay is checked before quotas. Repeated contact submissions conflict without
a time-based deduplication expiry. Public success exposes only a case reference;
contact details require the authorized operator view.

The tester application is a durable public submission of an address choice,
email, explicit consent and locale. It accepts no name or raw source/reference/
revision/provenance fields, and exposes only a case reference. There is no
operator acquisition endpoint. Reinstalling a changed or inactive demonstration
address tuple returns `starter_acquisition_seed_conflict` and rolls back.

## Purchase composition boundaries

| Action | What happens | Refusal code |
| --- | --- | --- |
| Take real payments, set up a payment method, replace a card or use cumulative refunds or absence reopening | Only sandbox payment attempts are available. These actions do not pause or freeze an existing subscription. | `native_prepared_attempt_store_unsupported` |
| Use an email address alone to access an existing purchase | Guest checkout is available, but existing-order access needs an owned customer session or an admitted recovery link. A recovery link grants no account or subscription-command access. | `customer_session_required` for account actions; `starter_recovery_unavailable` for unavailable recovery authority |
| Change the address of a parcel already in flight through the customer action | The destination change applies from the next parcel; the parcel in flight keeps its address. | —; result `applied_from_next_parcel` |

A new checkout issues a random recovery token; only its SHA-256 hash
is stored in the database. The creating response and private recovery message
carry it, never an authentication challenge or event. Creation, reminder-wave
and signed-in recovery links have a bounded lifetime from order creation and
preserve earlier links. Expiry-notice links use a longer bounded lifetime and
refer to the terminal source. Operator issuance revokes earlier order links and
caps expiry by both issuance time and the order’s recovery window.
Payment prevents further payment through every link. Payment-case links rotate
separately, keeping the live link unique within its case.

Completion removes the URL token before fetching configuration or rendering.
Requests carry it in the body; tab memory and session storage support reloads
without granting authority. An unchanged repeated submit keeps its token when
the response omits it. A different order never inherits it. Saving a new token
in a tab does not revoke other links.

A live pending-order link can continue sandbox payment after a decline.
Eligible expired initial checkouts, including system-abandoned ones, can create
a fresh order within the source’s bounded recovery window. Frozen re-quoting,
unchanged supported content, stock and proven prior non-settlement are required.
The terminal source is never paid. Token pay or exact-cookie retry can act on
the same pending replacement; the ordinary simulator cannot start an attempt
on that replacement. Paid presentation takes priority over any stored attempt.

Guest purchase needs no account. Checkout retains the email contact; sign in
with that email to view the purchase through an owned session. A customer
address result of `applied` confirms an update; `applied_from_next_parcel`
means an in-flight parcel keeps its current destination.

## Subscription mode price

| Action | What happens | Refusal code |
| --- | --- | --- |
| Quote subscription acquisition without a private acceptance key | The host refuses a subscription quote that needs signed acceptance. One-time checkout remains available. | `starter_quote_acceptance_key_required` |
| Reuse a subscription quote after acceptance-key rotation or changed terms | Refresh the quote and accept its current terms. | `starter_quote_refresh_required` |
| Reseed a different price under an existing price identity | The installation rolls back instead of overwriting that price. | `starter_price_seed_conflict` |
| Exceed checkout attempt limits or reuse a command key with a different contact/requester | Admission stops before contact resolution. The limits and identity bindings are process-local and reset on restart. | `starter_attempt_limited` |
| Submit an invalid or overlong purchase email | The configured input bound is checked before contact resolution. | `starter_email_invalid` |
| Treat demonstration market inputs as real tax or compliance certification | The starter uses fictional market and test-currency inputs. Subscription quotes use the installed pricing and acquisition rules; demonstration prices are not a real-market certification. | —; demonstration inputs only |

Catalogue estimates apply the configured subscription rate and rounding quantum
to each unit before quantity. `mode_discount` explains an included benefit;
it is not another order-level deduction. Installed quote and acquisition rules
own checkout totals and first-subscription terms. The first-subscription offer
is available through that quote/acceptance flow.

An identical price seed adds no entries; customer environments need their own
onboarding and acceptance keyring. Recreating the demonstration container rotates
its key, so unsubmitted subscription quotes must refresh. Restarting the same
container preserves the key.

Exact checkout replay keeps the command key, normalized email and requester and
uses no further quota. Changed identity under a retained key refuses before
contact resolution, even with a replaced quota callback. Capacity exhaustion
fails closed; denied attempts add no quota count. Both quota and identity
records reset on process restart. Unpurchased-contact retention remains the
application owner's duty.

Purchase and sign-in share the configured email bound. Phone and postal-code
fields share the native destination bounds. Cadences and the default use whole
days within the accepted range; checkout bounds line count and units per line
within the configured total. Stock and unit prices fit PostgreSQL integers, with
positive prices for every offered mode. Tax legal-basis text and the trimmed,
nonempty legal revision have bounded lengths. Consult the
[maintainer configuration limits](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/examples/neutral-store/docs/limits.md#interim-subscription-mode-price)
for exact values. Configuration outside these bounds refuses before startup.

## Paid-order message capture

| Action | What happens | Refusal code |
| --- | --- | --- |
| Deliver paid-order receipts to real recipients | Messages are captured privately on the local filesystem. A captured receipt does not establish email delivery. Subscription notices use their own local capture. | —; no real email transport |
| Use paid-order mail capture as a general event dispatcher | That dispatcher selects paid-order mail only. A settlement event can remain pending independently. | —; other events are not dispatched by this worker |

A paid order with an emitted paid-mail event and contact produces a deduplicated private
message record; unpaid and cancelled orders emit no such event. Reclaimed sends
deduplicate. Running the one-shot renewal command also drains paid mail when
renewal execution is disabled. A pending settlement event neither creates a
message record nor blocks the paid receipt.

## Subscription care

| Action | What happens | Refusal code |
| --- | --- | --- |
| Collect retention consent in the portal | No retention-consent capture is provided. Newsletter preferences do not grant retention consent; scheduled winback uses the native retention gate. | —; no consent capture control |
| Use signed unsubscribe or a legacy participant unsubscribe source | Signed unsubscribe is unbound. The legacy action has no participant source and refuses locally. | `host_binding_required` for signed unsubscribe; `native_legacy_tester_source_unavailable` for the legacy action |

Skip, slide, pause, resume, cancellation/save offers, order-now and reactivation
use trusted host timing. Browser data cannot establish charge eligibility.
Pause and cancel remain available with an open payment case, subject to the
in-flight fence. Winback retains the native default-on retention gate.
The portal shows native refusals and recorded delivery outcomes;
no generic edit verbs are mounted. A trusted host can record retention consent
through the native routine, while the portal supplies no consent-capture control.

## Account and operator bindings

| Action | What happens | Refusal code |
| --- | --- | --- |
| Correct a subscription customer’s email/phone or link an account as an operator | The visible operator identity-correction actions refuse. Customer self-service name/phone editing is separate. | `operator_subscription_authority_unavailable` |
| Add an order note or correct the order address | These visible actions refuse. Selecting a subscription destination is separate. | `starter_order_correction_unavailable` |
| Open private-profile or combined profile views | These visible actions refuse. Saved addresses, billing profiles and scoped preferences are separate. | `starter_account_preferences_unavailable` |
| Read a full account projection | The reduced account response includes a refusal in `fullProjection`; it does not supply the complete projection. | `starter_account_projection_binding_required` |
| Read historical order detail without captured money | The reader refuses missing or mismatched money rather than reconstructing it. | `native_account_order_money_unavailable` or `native_account_order_money_mismatch` |
| Use rich order-management reports, analytics, document guidance or saved account draft resume | Only reduced order-management reads are provided; the visible actions refuse. | `starter_rich_oms_unavailable` |
| Sign in through an external identity provider | The visible provider sign-in action refuses; the separate email-challenge flow does not enable it. | `oauth_not_supported` |
| Grant newsletter consent or manage another consent purpose through account preferences | The account endpoint allows newsletter read/withdraw only. | `host_binding_required` |
| Request an invoice correction | This appends a request, without a fiscal correction, refund, notification or operator case workflow. Repeated keys are not deduplicated. | —; request recording only |

Replacement creation, complete fulfillment cancellation and customer name/phone
editing are available through native bindings. Account-event history excludes
private payloads. Creating a replacement supplies no arrival confirmation.
Customer invoice history and owned captured-PDF downloads use the native session
principal. Operator invoice summaries authorize before reading local history,
duty, retry and delivery evidence, including for guest orders.

## Expired checkout recovery and order holds

| Action | What happens | Refusal code |
| --- | --- | --- |
| Pay a paid, manually cancelled or revoked checkout through recovery | No new payment can start. Expired source orders must qualify for recreation as a fresh order; the source itself is not paid. | `starter_recovery_paid` for an already-paid target; `starter_recovery_unavailable` for unavailable authority |
| Recreate after commercial changes, unsupported content, unavailable stock or uncertain prior settlement | Recreation must pass frozen re-quote, content, stock and prior non-settlement checks before replacement payment. | `starter_recovery_order_changed` or `starter_recovery_unavailable` |
| Recreate without the original private checkout capture | A missing, corrupt or erased original email capture refuses before a new quote or payment; current profile data cannot replace it. | `starter_recovery_unavailable` |
| Place or release an order hold without human-admin authority and a provisioned commerce operator | Both checks repeat for every command, including replay. | `operator_required` |
| Select a saved subscription address while the upcoming cycle is locked | A fresh selection refuses; existing order and parcel destinations stay unchanged. | `starter_payment_blocked` |

Eligible expired orders retain a shared Pay action. Draft, lineage and attempt
receipts keep replay on the unique replacement and its attempt. Reloading a dispatched
replacement reads that attempt independently of the source link's continuation
lifetime. Simulator controls require the inspected bearer/lineage/receipt and
disappear after capture.

Recovery uses the email from the original immutable private checkout capture,
not a current account email or later profile edit. Deleting that capture makes
recreation refuse; later notices cannot reconstruct it. Captures are personal
data. The application owner must provide mailbox access, retention and deletion;
the starter supplies no mailbox export/erasure procedure. Private captures stay
outside served assets, logs, traces and public reports.

Distributors and administrators without the provisioned Commerce row cannot
issue or replay holds. Release targets the exact hold reference. A locked
upcoming cycle returns `starter_payment_blocked` for
address changes; existing order and parcel destinations remain unchanged.

## Unpaid cancellation and manual refund records

| Action | What happens | Refusal code |
| --- | --- | --- |
| Cancel an unpaid order without confirmation or with incompatible payment/order state | Confirmation and a valid reason are required. Payment uncertainty or a conflicting state can refuse cancellation. This does not cancel a subscription or dispatched parcel. | `starter_input_invalid` or `starter_order_transition_conflict` |
| Use manual refund marking to move money | The operator records a refund already completed outside the app. This does not send money, issue a fiscal reversal, send a refund email or change a subscription. | —; external refund record only |

Read the exact order, enter a bounded nonempty trimmed reason and confirm
the shown consequence. Unpaid cancellation releases only held purchase
reservations; dispatched, indeterminate or captured payment evidence can refuse
it. Each command and replay rechecks human-admin authority and its Commerce
operator. Caller identity, missing confirmation, invalid reason, stale state and
conflicting commands refuse; native receipts retain replay identity.

## Return requests and decisions

| Action | What happens | Refusal code |
| --- | --- | --- |
| Request a return without an owned eligible order and valid quantities/reason | Customer admission and native return validation apply. Approval/rejection records refund intent only. | `customer_session_required`, `starter_input_invalid` or `starter_return_refused` |
| Open an operator returns list or detail | No reader is mounted. An authorized operator approves or rejects using the exact request reference received by the customer. | `starter_operation_unknown` with HTTP 404 for `operator.returns` |
| Receive returned goods | The visible action refuses; a return decision does not receive goods. | `starter_return_receive_unavailable` |
| Restock a return | The visible action refuses; a return decision does not restock. | `starter_return_restock_unavailable` |
| Execute a monetary return refund | The visible action refuses; full, partial and no-refund decisions record intent only. | `starter_monetary_refund_unavailable` |

A customer requests configured reason codes and positive item quantities from
their own paid or fulfilled order and keeps the returned reference. Full, partial
and no-refund decisions record intent; partial requires an explicit nonnegative
amount. A repeated decision retains its original note. Every decision and replay
rechecks the Commerce operator after fresh membership admission. No decision
changes a subscription.

## Optional payment guidance

| Action | What happens | Refusal code |
| --- | --- | --- |
| Infer a real method, instrument or provider advice from a sandbox decline | Guidance can identify a verified generic decline only. Missing or unusable guidance leaves the existing completion presentation unchanged; this read creates no payment or credential. | —; optional guidance may be absent |

The atomic guidance snapshot binds the exact order bearer, client, intent and
current attempt. Sandbox evidence does not identify an instrument, operation or
consecutive same-method refusal count. Synthetic choices use the explicit
sandbox registry. Missing or unsupported evidence, ineligible orders,
indeterminate attempts, observed success and read failures preserve the existing
presentation. No raw evidence or attempt history reaches the browser; this read
creates no notification or mutation.

## Operator shipment evidence

| Action | What happens | Refusal code |
| --- | --- | --- |
| Look up public tracking | The operation refuses even though authorized operator shipment reads and evidence commands are available. | `starter_tracking_access_unavailable` |
| Confirm an undelivered replacement as delivered | There is no separate replacement-arrival confirmation control. An undelivered replacement remains outstanding; a delivered tracking event must record actual arrival. | —; no separate attestation control |
| Hand off a historical parcel without recorded reservation associations | No current stock is acquired as a substitute; inspect the handoff result. | —; result `reservationDisposition: "reservations_not_recorded"` |
| Automatically purge stored label URLs and raw shipment payloads | No automatic retention cleanup is supplied. The application owner must control retention and authorized cleanup, including copies and backups. URL expiry does not delete stored evidence. | —; owner-managed cleanup |

Read the exact parcel and confirm each label, handoff or tracking action.
Every command and replay requires a fresh active human administrator; body-supplied
identities and command keys refuse. Labels require a provider namespace and
tracking number. Reusing a tracking identity across orders in the same namespace
or encountering unattributed conflicting history refuses. Same-order reassignment
and raw label-key replay keep their native receipt behavior.

Handoff consumes the recorded parcel reservations once. Before a fresh
nonterminal tracking event, parcel state and any supplied same-order reference
must be admitted. Terminal replay and earlier chronology repair keep their
native rules. Delivered evidence records actual arrival; explicit-zone occurrence
times can repair it earlier. Later inputs cannot postpone arrival, replace the
original receipt or move the next subscription cycle earlier.

Authorized operator detail can show label URLs. Full label requests and tracking
payloads stay private; customer/account/public-tracking views do not expose them.

## Saved addresses and scoped preferences

| Action | What happens | Refusal code |
| --- | --- | --- |
| Delete a saved address used by an active or paused subscription | Deletion refuses while the subscription uses the address. | `starter_address_in_use` |
| Assume a failed address or billing-profile save rolled back everything | Default clearing, saving and account-event append are separate writes. Reload before retrying. Billing command keys do not deduplicate writes or events. | —; partial writes can remain |
| Use a saved preference as a payment instrument or provider activation | Payment and delivery selections are scoped preferences only. They do not install an instrument, activate a provider or charge. | —; preference storage only |
| Export or erase all customer data through the starter | There is no HTTP export/erasure workflow. Application owners must complete privacy coverage and own access, retention and cleanup of saved data and private captures. | —; no export/erasure endpoint |

The account page can read, create, edit and delete owned saved addresses.
Address command replay returns the current book without another write. Deleting
a missing or foreign row acknowledges absence without deletion and returns only the caller's
book; editing a foreign row refuses.

An active or paused subscription can select an owned shipping/both address.
An admitted key replays before saved-ID parsing and returns the current pointer.
Null recipients stay null. Editing the saved row affects future materialization;
retained renewal operations and existing parcels keep immutable destinations.
The selection changes neither cadence, commercial terms nor billing.

Payment/delivery preferences use one-time, subscription or any scope. They append
no account events. Renewal chooses subscription scope before any scope and keeps
an explicit delivery choice. Incomplete locker pickup addresses can be saved
but are skipped during renewal delivery selection.

Billing profile create/read/edit/delete includes company identity fields and
owned tax normalization/checksum validation. Foreign edits refuse; deleting a
foreign or missing profile acknowledges absence without deletion. Address-book responses
include owned billing profiles. Default snapshots are redacted, unapplied hints:
they install no instrument or profile on an existing order.

## Sandbox token payment and exact continuation

| Action | What happens | Refusal code |
| --- | --- | --- |
| Use inline retry without the exact continuation cookie | A recovery bearer token or body identity cannot replace the cookie. An unregistered sandbox attempt has no inferred method identity for inline retry. | `starter_continuation_required` for missing or mismatched claims |
| Keep cookie-authorized controls after signing-key loss or rotation | Missing signing material leaves those controls unavailable; rotation invalidates old cookies. Keep the private acceptance-key root stable across restarts. | `starter_continuation_required` for inline retry without valid claims |
| Treat the embedded-browser send-link confirmation as delivery or payment | The cookie-authorized control captures a link in the private mailbox. Sending/enqueueing, local capture and payment are separate outcomes. | —; local capture only |

Dedicated token pay accepts registered synthetic choices on a live
checkout continuation. Admission reuses the latest owned descendant, intent and
reservation and refuses expired/revoked authority, renewals, terminal orders and
unresolved attempts. A later explicit retry can dispatch on that same replacement.

Only a fresh dispatched sandbox attempt mints continuation; checkout creation
does not. Private claims bind the real order, client, intent, attempt and rail.
The cookie is Secure, HttpOnly, SameSite=Strict with Path=/ and its bounded native
lifetime. Keep raw cookies, tokens and keys out of logs and public reports.
An exact failed predecessor and admitted guidance require a stable retry nonce.
Competing nonces, current-attempt checks and replay use atomic admission.
Response-loss replay returns the one dispatched replacement without another
dispatch and rotates its cookie. Captured, terminal, expired or stale targets
refuse before simulator effects. A still-live token can use dedicated pay when
an unregistered attempt cannot authorize inline retry. No method-hold policy is
configured; real execution, method setup and card replacement remain unavailable.

The send/send-again buyer control appears only in detected embedded browsers
after continuation exists. Detection grants no authority. Verified cookie claims
select order/client and the saved checkout recipient; sends deduplicate within
a bounded window. Sent confirmation survives remounting, sending again stays reachable
and failures offer retry. Sending, private capture and payment remain separate.

## Billing profiles and frozen invoice buyers

| Action | What happens | Refusal code |
| --- | --- | --- |
| Use captured invoices as fiscal documents | Invoice history and downloads are sandbox artifacts. | —; non-fiscal documents |
| Change an already captured invoice buyer by editing a profile/address | Buyer facts are frozen when the first invoice obligation is created. Later profile/address changes do not rewrite them; historical obligations are not backfilled. | —; immutable captured buyer |

On first invoice duty, explicit order buyer facts take precedence. Otherwise
the default or latest owned profile and billing/both address are selected
independently, with recorded shipping as the address fallback. Without either,
the buyer uses a marked shipping fallback. The snapshot keeps line2 and source
provenance. Recreation copies explicit buyer facts only when present; absent
facts stay absent for first-duty selection. Later edits or deletion cannot
change captured buyers, installed invoice facts or issued bytes.
Customer invoice history checks ownership; operator summary requires a current
human administrator.

Capture and subscription activation commit separately. An outage between them
is not an atomic purchase/activation guarantee. Privacy contributors cover
billing, addresses, preferences and parcel contacts; application owners still
supply identity/subscription coverage, account-event retention and authorized
private-capture cleanup.
