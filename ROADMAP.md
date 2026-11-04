# OpenLup roadmap

> OpenLup is a development preview, and plans are not release commitments: the order and scope of everything below may change. Read the [README status section](README.md#status-development-preview) before relying on any capability.

Last updated: 2026-11-03 · npm set: 0.36.0

## Current status

| Field | Value |
| --- | --- |
| Latest npm set | 0.36.0 |
| Status | development preview |
| Stable-framework gate (P1-SF) | open |

## Shipped modules

| ID | Name | Status | Release | Summary |
| --- | --- | --- | --- | --- |
| m01-outbox | M01 Durable outbox | shipped | 0.14.0 | Transactional enqueue, leased at-least-once dispatch, retry, snooze, discard and pruning with a default PostgreSQL store, published as @openlup/outbox. The application supplies the effect handlers and their idempotency. |
| m02-application-foundation | M02 Runnable application foundation | shipped | 0.15.0 | First publication of @openlup/platform: Node HTTP host, BFF dispatch, scheduled jobs with leases, configuration readiness, data gateways, migrations and blob storage. Importing the package activates nothing; the application supplies its environment, providers and composition. |
| m03-identity-privacy | M03 Identity, contacts, access control and privacy | shipped | 0.16.0 | Customer and operator sign-in and sessions, operator invitations, an opt-in OIDC token verifier, and personal-data export and erasure for direct PostgreSQL stores. On the managed rail, export reports incomplete coverage and erasure refuses without making changes. |
| m04-communications | M04 Communications and triggers | shipped | 0.17.0 | Consent and preferences, Polish and English default content, rendering, transport with explicit egress admission, delivery receipts, observations and reconciliation. Provider clients, copy, schedules and activation stay with the application, and a captured or accepted message is never reported as delivered. |
| m05-catalog-pricing | M05 Catalogue, offers, pricing, promotions and builder | shipped | 0.19.0 | Catalogue contracts and drafts, media, fixed bundles, price authority and quotes, subscription pricing policy, promotion eligibility and a post-discount free-shipping threshold. Lifecycle contracts include no catalogue publisher, and promotion codes are not available on the portable rail. |
| m06-stock-delivery-selection | M06 Stock, reservations and delivery selection | shipped | 0.20.0 | Stock ledger, available-to-promise, reservations, demand forecasting, shipping selection, addresses and flat-rate shipping. On the portable rail this module provides no stock adjustment or address writes. |
| m07-payments | M07 Payments and durable money truth | shipped | 0.21.0 | Prepared payment attempts, verified provider evidence, payment truth, reconciliation and repair, plus opt-in example payment adapters. A browser return never proves payment and a refund never cancels a subscription; payment-method setup and cumulative refunds are not available on the portable rail. |
| m08-fulfillment | M08 Fulfillment and physical delivery | shipped | 0.22.0 | Paid handoff, fenced dispatch, tracking observations, recovery, product and stock sync and delivery alignment, plus an opt-in warehouse adapter example. A late delivery extends the next cycle and never stacks deliveries, and an undelivered replacement is never reported as delivered. |
| m09-invoicing | M09 Invoices, corrections and settlements | shipped | 0.24.0 | Invoice issue, correction and reversal workers, seller details frozen at the first claim, payout links, PDF checks and owned invoice reads. Nothing is activated by default, and no fiscal provider or country-specific accounting acceptance is claimed. |
| m10-subscriptions | M10 Subscriptions, renewal and dunning | shipped | 0.26.0 | Activation, cadence, renewal scheduling, payment retries, dunning and repair, subscription commands and stock-wait handling. A refund does not cancel a subscription, and multi-cycle prepaid subscriptions are not available. |
| m11-commerce-orders | M11 Commerce and order operations | shipped | 0.27.0 | Quotes, checkout with draft, finalize, compensation, replay and expiry, order holds, cancellation, replacements, return requests with approval and rejection, and reviews. Creating a monetary refund is excluded, though an external refund can be marked, and receiving, restocking and refunding returns are not built. |
| m12-account-support | M12 Account and customer support | shipped | 0.28.0 | Customer order and invoice history; pause, skip, resume and cancel; date, item, quantity, address and payment-method changes; reorder; Customer 360 and operator recovery. The host keeps authorization and private profile extensions, and several of these actions reach the portable rail only in M19. |
| m13-acquisition-marketing | M13 Acquisition, research and marketing facts | shipped | 0.29.0 | Acquisition and research capture, consent and analytics facts, a tester application flow, baseline SEO and structured data. Remote profile deletion is not claimed, and turning a new acquisition contact into a customer is not built. |
| m14-operations-portability | M14 Operations, observability and store portability | shipped | 0.33.0 | Operations settings, jobs, alerts and diagnostics; upgrade and backfill; local store transfer and restore; and recipes for PostgreSQL, identity, object storage and Node or OCI hosts. No hosted transfer or recovery has run, and the Neon, Neon to Amazon RDS and independent PaaS work moves to the hostability round after M19. |
| m15-risk-controls | M15 Generic risk controls | shipped | 0.32.0 | Risk scoring, blocklist checks, paid-order assessment and an operator review queue. Risk controls are off by default, and no fraud provider or enabled risk policy is included. |
| m16-addresses-market-packs | M16 Addresses, company identity and market packs | shipped | 0.33.0 | Company lookup with provider order and a shared cache, address schemas, and settlement, fiscal and formatting helpers driven by explicit market facts. The first version covers Polish and English; other markets and locales are not claimed, and national registry adapters are not packaged. |
| m17-channel-ingest | M17 Normalized external-channel ingest | shipped | 0.35.0 | Normalized channel contracts with ingest, webhook, operator, pull and recovery bindings, quarantine and replay. No real marketplace connector ships, conversion to a physical order refuses on the portable rail, and channel data export and erasure are unavailable. |
| m18-partner-inquiries | M18 Neutral partner inquiries | shipped | 0.36.0 | Partner acquisition schemas, port and PostgreSQL store for capture, listing and status transitions. A closed_won status does not create a customer or marketing consent, and there is no partner data export or deletion. |

## M19a: working store

| ID | Name | Status | Release | Summary |
| --- | --- | --- | --- | --- |
| m19a-npm-database-install | Database installation from npm | in-progress | S1a | The platform package carries the complete portable PostgreSQL migration histories and a runner, so a store installs its database without a source checkout. A fresh installation selects its generation and PostgreSQL 16 role profile, and an existing history cannot change generation. |
| m19a-guest-checkout | Guest checkout with an account from the purchase | in-progress | S1a | A buyer purchases once or by subscription without signing in, and checkout finds or creates the contact for that email. Signing in later with the same email shows the orders, subscription, address and invoices. Checkout attempt limits are kept in one process and reset on restart until the hostability round. |
| m19a-checkout-drafts | Checkout drafts on the portable rail | in-progress | S1a | Checkout persists drafts over the existing order routines, keeps the quote and draft money snapshots and replays one durable receipt. Changed input is refused instead of replacing or paying the order. |
| m19a-pricing-engine | Pricing engine on the portable rail | in-progress | S1a | Price authority, quote catalogue and promotion data reads let the store price through the package quote engine, with a single quote path. Prices, products, discounts and subscription terms are adopter configuration, not built-in values. |
| m19a-acquisition-discount | First-purchase acquisition discount | planned | S1a | The acquisition promotion mechanism, with its eligibility and caps, moves onto the package quote engine. Its values are adopter configuration; promotion codes and the acquisition schedule come in the promotions round. |
| m19a-sandbox-payments | Sandbox payments and renewal setup | in-progress | S1a | A sandbox payment simulator with verified server observations, and purchase-time renewal terms so that a new subscription becomes due. A browser return cannot pay an order, a capture after cancellation stays an operator-review fact without an automatic refund, and no real money is taken (see N6). |
| m19a-stock-holds | Stock holds for new purchases | in-progress | S1a | Purchases hold stock, then release it or let it expire, and an abandoned order releases its holds. The portable rail does not track lots, locations or stock movements. |
| m19a-delivery-address | Order and subscription delivery address | in-progress | S1a | Orders and subscriptions carry a delivery destination, and a subscription address change applies to future orders. Orders and parcels that already exist keep their address; a saved address book comes in M19b1b. |
| m19a-renewal-recovery | Renewals, retries and recovery on the portable rail | in-progress | S1a | Automatic renewal, payment retries, dunning, repair and recovery, delivery alignment and stock waits run on the portable rail. A renewal bills from its frozen terms, never from live catalogue prices. |
| m19a-recovery-link | Payment recovery link | in-progress | S1a | A recovery link lets a buyer pay an unpaid order without an account, for 24 hours after the order is created. Issuing a new link ends the previous one, so each order has one live link until M19b1a. |
| m19a-notices | Order and payment notices | in-progress | S1a | Paid-order email, subscription lifecycle notices and payment-recovery notices on the portable rail. A failed message delivery leaves order state unchanged, and the neutral store captures messages locally instead of sending them. |
| m19a-shipping-charges | Shipping charges and free-shipping threshold | in-progress | S1a | One-off orders and renewals charge shipping, with the free-shipping threshold applied after discounts. Until this lands, shipping is zero on the portable rail; the amounts are adopter configuration. |
| m19a-captured-invoices | Captured invoices and invoice history | in-progress | S1a | An explicitly selected captured sandbox provider issues append-only, non-fiscal PDFs, and customers read and download their own invoice history. No real accounting provider is involved. |
| m19a-captured-fulfillment | Captured fulfillment dispatch | in-progress | S1a | A default-off captured dispatch adapter and a locked dispatch-preparation binding, with replay. Captures are synthetic evidence; they do not qualify a provider or record a physical delivery. |
| m19a-operator-shipments | Operator shipment list and detail | in-progress | S1a | Operators list shipments and open their detail on the portable rail. Richer shipment views remain named limits that refuse by code. |
| m19a-account-reads | Customer account reads | in-progress | S1a | Account readers for owned orders, subscriptions, invoices and newsletter withdrawal on the portable rail. Saved addresses, billing profiles and preferences refuse by name until M19b1b, and an order without captured money shows what was recorded instead of zeros. |
| m19a-account-consents | Account consent choices | in-progress | S1a | Customers read, grant and withdraw newsletter consent from their account, with a provenance record. A saved preference alone never counts as consent. |
| m19a-order-operations | Order, return and support stores from npm | in-progress | S1a | Order management, returns and customer-support stores are available through package entries, and the order list and count work on the portable rail. Rich order projections keep their named refusals. |
| m19a-bundle-admin | Bundle administration writes | in-progress | S1a | Operators create and edit bundle compositions through the catalogue entry, including on the portable rail. An activated bundle cannot be purchased in this release. |
| m19a-neutral-store | Neutral store starter | in-progress | S1a | A source application, not an npm package, with fictional supplement and coffee catalogues, local PostgreSQL bootstrap, partner and tester intake, operator support and catalogue administration, and a typed customization input. It runs on a local demonstration database only, and its purchase path is still being connected. |
| m19a-starter-operations | Invoices, returns and order actions in the neutral store | planned | S1a | The neutral store adds its invoice route and the order and return actions that already work end to end on the portable rail. Operator returns handling, cancellation and refund marking, shipment views and an operator invoice summary that need further database work refuse with named codes until M19b1b. |
| m19a-starter-subscription-journeys | Renewal, recovery, notice, consent and review journeys in the neutral store | planned | S1a | Browser journeys for renewal, payment recovery, notices, consent choices and purchase-linked reviews. The fixed expiry of a review right is proved in tests, not end to end. |
| m19a-upgrade-cli | openlup command for upgrades and verification | in-progress | S1a | A command that plans and applies application-file upgrades and verifies a composed store, with each finding giving the observed state, cause, fix and recheck. Upgrades keep local edits and run no SQL or package installation, and verification only reads. |
| m19a-conformance-kit | Communications adapter conformance kit | in-progress | S1a | An offline conformance runner for email and marketing-sync adapters with bounded fix and recheck findings. Passing fixtures do not qualify a provider. |
| m19a-own-stack-example | Own-stack integration example | in-progress | S1a | A small existing application with its own routing and authentication uses one catalogue capability through public factories and ports, without the neutral store. |
| m19a-distribution-evidence | Distribution evidence and package BOM | in-progress | S1a | A generator for the package-set bill of materials and a public outcome projection that links exports to proof sources. Neither is a release receipt, and a partial projection blocks a complete-outcome claim. |
| m19a-restricted-runtime-completion | Subscription commands and discounted settlement on the restricted self-host runtime | in-progress | S1a | On the restricted database runtime used by self-hosted stores, customer and operator cancel, pause, resume and date changes, and the payment settlement of an order with a promotion discount, currently refuse with a privilege error and change nothing. This release grants exactly the access those paths need, with row-level security still preventing direct updates. |
| m19a-public-limits | Public limits table and install policy | in-progress | S1a | Every action the portable store does not perform refuses by a named code listed in one public limits table, and the install policy text is updated to match the release. |
| m19a-store-transfer-proof | Store transfer proof | in-progress | S1a | A store that has run the journey from purchase to recovery is captured, restored on a clean database and then renews. Transfer packets are tied to their capture profile and are recaptured rather than converted. |
| m19a-fresh-adopter-run | Fresh adopter run | planned | S1a | After the release, a fresh agent with only the public release and documentation creates a store for a new brand, customizes it, adds an extension, diagnoses a seeded failure and upgrades. It is an agent-measured run, not independent-adopter evidence. |

## M19b1a: subscription care

| ID | Name | Status | Release | Summary |
| --- | --- | --- | --- | --- |
| m19b1a-pause | Pause and resume | planned | S1b1a | Customers pause for two weeks, one month or indefinitely and resume by hand or on a timer, in the neutral store's customer portal. Pausing closes any open payment-recovery case and revokes its links, and late notices do not revive it. |
| m19b1a-reminder-timing | Reminder timing and at-risk cap | planned | S1b1a | Configurable timing for renewal and pause-end reminders and a cap on reminders for subscriptions at risk. The timing values are adopter configuration. |
| m19b1a-operator-escalation | Operator escalation | planned | S1b1a | Subscriptions that automatic payment recovery does not resolve are escalated to the store's operators. |
| m19b1a-winback | Winback | planned | S1b1a | A scheduled winback flow for customers who have cancelled, with eligibility checked again just before sending. Whether winback needs retention-marketing consent, and the offer values, are adopter configuration. |
| m19b1a-order-now-reactivate | Order now and reactivate | planned | S1b1a | Customers order their next delivery now or reactivate a subscription from the customer portal. |
| m19b1a-save-offers | Save offers | planned | S1b1a | Customers who start to cancel are offered alternatives such as skipping or moving a delivery in the customer portal, and the outcome is recorded. |
| m19b1a-configurable-timing | Configurable timing and terms | planned | S1b1a | Subscription timing and terms become adopter configuration that changes without code edits. |
| m19b1a-several-live-links | Several live payment links per order | planned | S1b1a | An order can have several live checkout payment links at once, while a payment-recovery case keeps exactly one live link. The flows that send these links come in M19b1b. |

## M19b1b: payment recovery and account

| ID | Name | Status | Release | Summary |
| --- | --- | --- | --- | --- |
| m19b1b-payment-recovery-links | Payment recovery reminders and links | planned | S1b1b | Reminder waves for unpaid orders, an operator-sent payment link and a recovery start for signed-in customers. On the portable rail these flows take sandbox payments only. |
| m19b1b-recovery-pages | Payment recovery pages | planned | S1b1b | Recreating an expired payment link, payment guidance, and paying from a recovery link with an inline retry after a failed attempt. |
| m19b1b-saved-addresses-preferences | Saved addresses and preferences | planned | S1b1b | A saved address book with delivery and payment preferences, managed in the customer portal; renewals use the saved delivery preference. Until this lands, these account sections refuse by name rather than returning empty data. |
| m19b1b-billing-profile | Billing profile | planned | S1b1b | Customers keep billing details for future invoices in their account. Invoices already issued keep the details they were issued with. |
| m19b1b-invoice-correction | Invoice correction request | planned | S1b1b | Customers send an invoice correction request from their account, and the request is recorded for the store's operators. |
| m19b1b-profile-edit | Profile edit | planned | S1b1b | Customers edit their name and phone number in the customer portal. Changing the sign-in email is not part of this. |
| m19b1b-operator-replacement | Operator replacement and fulfillment cancellation | planned | S1b1b | Operators send a replacement for a delivery problem or cancel the fulfillment of a whole order. A replacement settles the subscription cycle only after it reaches the customer, and deliveries never stack. |
| m19b1b-operator-order-operations | Operator order operations | planned | S1b1b | Operators handle returns with replayable decisions and decision events, cancel orders and mark refunds made outside OpenLup, and see shipment views on the portable rail. Creating monetary refunds through a payment provider stays out of scope. |

## M19b2: subscription editor

| ID | Name | Status | Release | Summary |
| --- | --- | --- | --- | --- |
| m19b2-classic-editor | Classic subscription editor | planned | S1b2 | Customers change the items and cadence of a subscription in the customer portal, see a server-side price preview and apply it; applying refuses if the price moved since the preview. A minimum order quantity is enforced on the server and in the database, and its value is adopter configuration. |
| m19b2-exact-levers | Exact change levers | planned | S1b2 | Swap, add-on add, remove and quantity, plan length, mix and portion changes, as package API and neutral-store host routes. They have no customer portal buttons; customers in the portal use the classic editor. |
| m19b2-sized-editor | Sized plan editor | planned | S1b2 | Customers opt a subscription into a sized, agreed plan and edit it in the customer portal. Lines are checked against the current sellable catalogue; fencing against published catalogue versions waits for a catalogue publication workflow. |

## After M19

| ID | Name | Status | Release | Summary |
| --- | --- | --- | --- | --- |
| n6-portable-real-money | N6: real payments on the portable rail | planned | - | A real payment provider on the portable rail, with payment-method setup, cumulative refunds and card replacement. Until it lands, real money runs only on the managed rail, so a portable real-money store without vendor lock-in is not available. Proposed as the first round after M19; the project owner sets the order of all rounds after M19. |
| hostability-providers | Hostability and provider portability | planned | - | Hosted runs and provider portability: a Neon receipt, Neon to Amazon RDS transfer and recovery, an independent PaaS candidate with Netlify first, a hosted database connection and a Vercel host for the neutral store, and a checkout attempt limiter that survives restarts. The providers in scope are Vercel, Netlify, AWS and Neon. Until then no hosted claim is made, and the neutral store runs on its local demonstration database. |
| promotions-codes-schedule | Promotions: codes and acquisition schedule | planned | - | Promotion codes with a code catalogue, claims and limits, an operator code center and a checkout code card, plus an acquisition schedule writer with a command line. Device evidence for eligibility is decided together with a retention and erasure design. Until then, promotion codes are not available on the portable rail. |
| a5-market-adapters | A5 market adapters | planned | - | An example company and customer lookup adapter built on Polish public registries (VAT whitelist, GUS/CEIDG), after the company-identity and invoicing ports are frozen. Data provenance, freshness, licence and fallback are settled first, and other market adapters can follow the same pattern. |
| p1-sf-stable-framework | P1-SF stable framework | planned | - | The stable-framework gate needs a versioned release and bill of materials, a thin adopter application, public extension and conformance contracts, upgrade tools, and passing installation, compatibility, provenance and independent-adopter evidence. An npm latest tag does not close it, and until it closes OpenLup remains a development preview. |

## Providers and adapters

| ID | Adapter | On npm | Lane | Proof scope |
| --- | --- | --- | --- | --- |
| supabase-postgresql | Supabase PostgreSQL (managed database) | yes | managed | Data gateway and job ledger for the managed rail. Fresh-install, upgrade and existing-store restore proofs for this rail remain partial. |
| supabase-auth | Supabase Auth | yes | managed | Customer and operator sign-in on the managed rail. Operator sign-in smoke checks and a hosted settings readback remain open. |
| supabase-storage | Supabase Storage | yes | managed | Blob storage binding. Serving and access proofs remain open. |
| portable-postgresql | Portable PostgreSQL (self-host and Amazon RDS recipes) | yes | portable | Local self-host recipe receipt, local store transfer and restore witnesses, and one hosted RDS PostgreSQL 16 recipe run on a single synthetic instance. No hosted transfer or recovery has run, and none of this is production qualification. |
| neon | Neon | no | portable | No receipt yet. A Neon recipe receipt and Neon to Amazon RDS transfer and recovery are planned in the hostability round. |
| oidc-identity | Generic OIDC and JWKS identity | yes | portable | Opt-in access-token verifier. A real-issuer lifecycle witness passed on one disposable hosted origin; no production qualification. |
| s3-object-storage | S3-compatible object storage | yes | portable and managed | Local recipe with two gateway accounts and one hosted run on a single synthetic bucket in one region. No production qualification. |
| vercel | Vercel (Node functions, scheduled jobs, Blob) | yes | managed | Blob binding and the reference default bundle with the managed database, without the Edge runtime. A Vercel host for the portable neutral store is planned in the hostability round. |
| node-oci-host | Generic Node host and OCI image | yes | portable | Local self-host receipt and one hosted run on a single synthetic VM with restart, drain and A to B to A rollback checks. No production qualification. |
| netlify | Netlify (independent PaaS candidate) | no | portable | Candidate only, not yet measured. It is evaluated in the hostability round. |
| resend | Resend email | yes | portable and managed | Opt-in adapter on the communications entry with offline conformance. No provider-account evidence. |
| klaviyo | Klaviyo marketing sync | yes | portable and managed | Opt-in adapter with offline conformance only; account verification is pending. |
| stripe | Stripe payments | yes | managed | Opt-in example adapter with an injected client. Refund creation and split authorization and capture are not available, some hosted paths are not observed, and real money runs only on the managed rail. |
| tpay | Tpay payments | yes | managed | Opt-in example adapter with simulator evidence only. Real settlement and provider readback are not verified. |
| omnipack | OmniPack warehouse fulfillment | yes | managed | Opt-in, default-off example with offline conformance. Exact absence, label create and void and cancellation are not available, and some dispatch and reconciliation paths have not been exercised. |
| polish-company-registries | Polish company registries (VAT whitelist, GUS/CEIDG) | no | portable and managed | Not packaged. A packaged example lookup adapter comes in the A5 adapter round. |
| external-channels | External sales channels (normalized import) | yes | portable and managed | Normalized ingest contracts and bindings. No real connector ships, and conversion to a physical order refuses on the portable rail. |

## Deferred and not built

| ID | Name | Status | Release | Summary |
| --- | --- | --- | --- | --- |
| deferred-bundle-purchase | Buying an activated bundle | deferred | - | Operators can manage bundles, but an activated bundle cannot be purchased in M19. It comes in a later round. |
| deferred-returns-reader | Operator returns list on the portable rail | deferred | - | Operators approve or reject a return by its reference, but there is no operator returns list on the portable rail. It is a follow-up after M19. |
| deferred-return-receipt-refund | Return receipt, restock and refund | deferred | - | Receiving returned goods, restocking them and refunding a return are not built on any rail. Return requests, approval and rejection work. |
| deferred-refund-creation | Creating monetary refunds | deferred | - | OpenLup does not create monetary refunds through a payment provider. An operator can mark a refund made outside OpenLup. |
| deferred-multi-cycle-prepaid | Multi-cycle prepaid subscriptions | deferred | - | Subscriptions paid in advance for several cycles are not available. |
| deferred-partner-conversion | Partner conversion, export and deletion | deferred | - | Converting a partner inquiry into a customer, and exporting or deleting partner data, are not built. |
| deferred-portable-lot-tracking | Lot and location tracking on the portable rail | deferred | - | The portable rail does not record lots, locations or stock movements. Stock holds, release, expiry and stock accounting work. |
| deferred-catalogue-publication | Catalogue publication workflow | deferred | - | Creating, activating and withdrawing variants with publication to product pages is planned as its own round and is not scheduled. Catalogue drafts and administration work. |
| deferred-operator-contact-edits | Operator contact edits and order notes on the portable rail | deferred | - | Operator changes to a customer's email, phone and account link, order notes and order address corrections refuse by name on the portable rail. |
| deferred-rich-order-reports | Rich order projections and reports on the portable rail | deferred | - | Rich operator order projections, analytics, document guidance, saved draft resume and commercial reports refuse by name on the portable rail. Reduced order reads work. |
| deferred-portable-social-sign-in | Social sign-in on the portable rail | deferred | - | Customer sign-in with a social account is not provided on the portable rail. Email magic links and one-time codes work. |
