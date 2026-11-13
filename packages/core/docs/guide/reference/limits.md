# Starter limits

Use this reference to decide whether the `examples/neutral-store` starter meets your needs and to recognize its refusals while running it.
It uses a local demonstration database, sandbox payments and private message capture.

The app’s `/limits` and `/ograniczenia` pages and unavailable-action buttons use the
[canonical limits table](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/neutral-store/shared/limits.ts).
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
| Keep demonstration sessions across a restart | Sessions live in one process, expire after an hour and disappear on restart. Issuance stops when the session store is full. | `starter_session_capacity_exceeded` at capacity |
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

## Purchase composition boundaries

| Action | What happens | Refusal code |
| --- | --- | --- |
| Take real payments, set up a payment method, replace a card or use cumulative refunds or absence reopening | Only sandbox payment attempts are available. These actions do not pause or freeze an existing subscription. | `native_prepared_attempt_store_unsupported` |
| Use an email address alone to access an existing purchase | Guest checkout is available, but existing-order access needs an owned customer session or an admitted recovery link. A recovery link grants no account or subscription-command access. | `customer_session_required` for account actions; `starter_recovery_unavailable` for unavailable recovery authority |
| Change the address of a parcel already in flight through the customer action | The destination change applies from the next parcel; the parcel in flight keeps its address. | —; result `applied_from_next_parcel` |

## Subscription mode price

| Action | What happens | Refusal code |
| --- | --- | --- |
| Quote subscription acquisition without a private acceptance key | The host refuses a subscription quote that needs signed acceptance. One-time checkout remains available. | `starter_quote_acceptance_key_required` |
| Reuse a subscription quote after acceptance-key rotation or changed terms | Refresh the quote and accept its current terms. | `starter_quote_refresh_required` |
| Reseed a different price under an existing price identity | The installation rolls back instead of overwriting that price. | `starter_price_seed_conflict` |
| Exceed checkout attempt limits or reuse a command key with a different contact/requester | Admission stops before contact resolution. The limits and identity bindings are process-local and reset on restart. | `starter_attempt_limited` |
| Submit an invalid or overlong purchase email | The configured input bound is checked before contact resolution. | `starter_email_invalid` |
| Treat demonstration market inputs as real tax or compliance certification | The starter uses fictional market and test-currency inputs. Subscription quotes use the installed pricing and acquisition rules; demonstration prices are not a real-market certification. | —; demonstration inputs only |

## Paid-order message capture

| Action | What happens | Refusal code |
| --- | --- | --- |
| Deliver paid-order receipts to real recipients | Messages are captured privately on the local filesystem. A captured receipt does not establish email delivery. Subscription notices use their own local capture. | —; no real email transport |
| Use paid-order mail capture as a general event dispatcher | That dispatcher selects paid-order mail only. A settlement event can remain pending independently. | —; other events are not dispatched by this worker |

## Subscription care

| Action | What happens | Refusal code |
| --- | --- | --- |
| Collect retention consent in the portal | No retention-consent capture is provided. Newsletter preferences do not grant retention consent; scheduled winback uses the native retention gate. | —; no consent capture control |
| Use signed unsubscribe or a legacy participant unsubscribe source | Signed unsubscribe is unbound. The legacy action has no participant source and refuses locally. | `host_binding_required` for signed unsubscribe; `native_legacy_tester_source_unavailable` for the legacy action |

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

## Expired checkout recovery and order holds

| Action | What happens | Refusal code |
| --- | --- | --- |
| Pay a paid, manually cancelled or revoked checkout through recovery | No new payment can start. Expired source orders must qualify for recreation as a fresh order; the source itself is not paid. | `starter_recovery_paid` for an already-paid target; `starter_recovery_unavailable` for unavailable authority |
| Recreate after commercial changes, unsupported content, unavailable stock or uncertain prior settlement | Recreation must pass frozen re-quote, content, stock and prior non-settlement checks before replacement payment. | `starter_recovery_order_changed` or `starter_recovery_unavailable` |
| Recreate without the original private checkout capture | A missing, corrupt or erased original email capture refuses before a new quote or payment; current profile data cannot replace it. | `starter_recovery_unavailable` |
| Place or release an order hold without human-admin authority and a provisioned commerce operator | Both checks repeat for every command, including replay. | `operator_required` |
| Select a saved subscription address while the upcoming cycle is locked | A fresh selection refuses; existing order and parcel destinations stay unchanged. | `starter_payment_blocked` |

## Unpaid cancellation and manual refund records

| Action | What happens | Refusal code |
| --- | --- | --- |
| Cancel an unpaid order without confirmation or with incompatible payment/order state | Confirmation and a valid reason are required. Payment uncertainty or a conflicting state can refuse cancellation. This does not cancel a subscription or dispatched parcel. | `starter_input_invalid` or `starter_order_transition_conflict` |
| Use manual refund marking to move money | The operator records a refund already completed outside the app. This does not send money, issue a fiscal reversal, send a refund email or change a subscription. | —; external refund record only |

## Return requests and decisions

| Action | What happens | Refusal code |
| --- | --- | --- |
| Request a return without an owned eligible order and valid quantities/reason | Customer admission and native return validation apply. Approval/rejection records refund intent only. | `customer_session_required`, `starter_input_invalid` or `starter_return_refused` |
| Open an operator returns list or detail | No reader is mounted. An authorized operator approves or rejects using the exact request reference received by the customer. | `starter_operation_unknown` with HTTP 404 for `operator.returns` |
| Receive returned goods | The visible action refuses; a return decision does not receive goods. | `starter_return_receive_unavailable` |
| Restock a return | The visible action refuses; a return decision does not restock. | `starter_return_restock_unavailable` |
| Execute a monetary return refund | The visible action refuses; full, partial and no-refund decisions record intent only. | `starter_monetary_refund_unavailable` |

## Optional payment guidance

| Action | What happens | Refusal code |
| --- | --- | --- |
| Infer a real method, instrument or provider advice from a sandbox decline | Guidance can identify a verified generic decline only. Missing or unusable guidance leaves the existing completion presentation unchanged; this read creates no payment or credential. | —; optional guidance may be absent |

## Operator shipment evidence

| Action | What happens | Refusal code |
| --- | --- | --- |
| Look up public tracking | The operation refuses even though authorized operator shipment reads and evidence commands are available. | `starter_tracking_access_unavailable` |
| Confirm an undelivered replacement as delivered | There is no separate replacement-arrival confirmation control. An undelivered replacement remains outstanding; a delivered tracking event must record actual arrival. | —; no separate attestation control |
| Hand off a historical parcel without recorded reservation associations | No current stock is acquired as a substitute; inspect the handoff result. | —; result `reservationDisposition: "reservations_not_recorded"` |
| Automatically purge stored label URLs and raw shipment payloads | No automatic retention cleanup is supplied. The application owner must control retention and authorized cleanup, including copies and backups. URL expiry does not delete stored evidence. | —; owner-managed cleanup |

## Saved addresses and scoped preferences

| Action | What happens | Refusal code |
| --- | --- | --- |
| Delete a saved address used by an active or paused subscription | Deletion refuses while the subscription uses the address. | `starter_address_in_use` |
| Assume a failed address or billing-profile save rolled back everything | Default clearing, saving and account-event append are separate writes. Reload before retrying. Billing command keys do not deduplicate writes or events. | —; partial writes can remain |
| Use a saved preference as a payment instrument or provider activation | Payment and delivery selections are scoped preferences only. They do not install an instrument, activate a provider or charge. | —; preference storage only |
| Export or erase all customer data through the starter | There is no HTTP export/erasure workflow. Application owners must complete privacy coverage and own access, retention and cleanup of saved data and private captures. | —; no export/erasure endpoint |

## Sandbox token payment and exact continuation

| Action | What happens | Refusal code |
| --- | --- | --- |
| Use inline retry without the exact continuation cookie | A recovery bearer token or body identity cannot replace the cookie. An unregistered sandbox attempt has no inferred method identity for inline retry. | `starter_continuation_required` for missing or mismatched claims |
| Keep cookie-authorized controls after signing-key loss or rotation | Missing signing material leaves those controls unavailable; rotation invalidates old cookies. Keep the private acceptance-key root stable across restarts. | `starter_continuation_required` for inline retry without valid claims |
| Treat the embedded-browser send-link confirmation as delivery or payment | The cookie-authorized control captures a link in the private mailbox. Sending/enqueueing, local capture and payment are separate outcomes. | —; local capture only |

## Billing profiles and frozen invoice buyers

| Action | What happens | Refusal code |
| --- | --- | --- |
| Use captured invoices as fiscal documents | Invoice history and downloads are sandbox artifacts. | —; non-fiscal documents |
| Change an already captured invoice buyer by editing a profile/address | Buyer facts are frozen when the first invoice obligation is created. Later profile/address changes do not rewrite them; historical obligations are not backfilled. | —; immutable captured buyer |
