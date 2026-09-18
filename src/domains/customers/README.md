# customers domain

Hidden passwordless customer-account surface: `customers/me` profile
(orders/subscriptions summary) keyed to the magic-link session plus the hidden
customer self-service account foundation. Hidden customer defaults expose
payment preference summaries and address/orderer facts. Distinct from `clients`
(persistence) — this is the logged-in customer's own customer-safe view and
mutation boundary.

Route availability is deployment-owned. This README documents the current
customer-safe source boundary, not a public activation prerequisite or a route
availability promise. Server routes retain customer-session authorization except
for explicit session-bootstrap and recovery surfaces such as `magic-link` and
token-authenticated abandoned-checkout recovery.

## Owns / does not own
- **Owns:** customer profile/account read contracts, customer-safe profile/pet/address/billing-profile mutation contracts, sanitized payment preference summaries, order-history read contracts, authenticated invoice download tickets, invoice-correction intents, and the authenticated facade for subscription self-service action/preview requests.
- **Does not own:** client persistence (`clients`), marketing consent permission state (`communications`), PSP payment methods or vaulting (`payment`), subscription state machine (`subscription`), order persistence (`commerce`), fulfillment dispatch/tracking providers (`fulfillment`), accounting ledger mutation (`accounting`), auth provider config (`platform`).

## Public surface (import cross-domain ONLY these)
- `contracts.ts` (src) — `CustomerMeResponse`, preference, and address/orderer schemas.
- `accountV2Contracts.ts` (src) — authenticated `/konto` aggregate contracts,
  including customer-safe order tracking numbers, current invoice selection,
  fiscal `invoiceDocuments[]` history, and timeline events sourced from
  fulfillment/provider evidence. Email delivery copy distinguishes provider
  acceptance from independently proven inbox delivery.
- `selfServiceContracts.ts` (src) — hidden account read model and profile/pet/address mutation schemas.
- `subscriptionFacadeContracts.ts` (src) — customer-authenticated facade over
  subscription-owned self-service preview/action contracts.
- `customerMeClient.ts` — hidden `/api/bff/customers/me` BFF client.
- `customerMagicLinkClient.ts` — hidden passwordless magic-link request client.
- `customerPreferencesClient.ts` — hidden customer payment preference and
  delivery-preference BFF client (`/api/bff/customers/delivery-preferences`).
- `customerPaymentMethodsClient.ts` — hidden authenticated saved payment method
  summary client.
- `paymentMethodSetupClient.ts` — authenticated saved-payment-method setup
  client for customer self-service card/payment updates.
- `customerReconcileClient.ts` — hidden authenticated reconcile-account client.
- `customerAddressesClient.ts` — hidden read-only customer address/orderer BFF client.
- `customerSelfServiceClient.ts` — hidden self-service account/profile/pet/address/billing/order/subscription-action/preview/recovery-start BFF client.
- Communication preferences for `/konto` live in
  `src/domains/communications/customerPreferencesClient.ts`; `customers`
  provides the authenticated route ownership but not the consent ledger.
- `ports.ts` (api) — customer read/preference/address/billing/order ports.

## Where the code lives
- Shared/frontend: `src/domains/customers/` (contracts and hidden BFF clients)
- Server: `server/domains/customers/` (`customerMeHandler.ts`, preference/address/self-service handlers, ports)
- BFF routes: `server/bff/customers/me.ts`, `preferences.ts`,
  `communication-preferences.ts`, `addresses.ts`, `account.ts`, `profile.ts`,
  `pets.ts`, `billing-profiles.ts`, `delivery-preferences.ts`,
  `payment-methods.ts`, `magic-link.ts`, `reconcile-account.ts`, `orders.ts`,
  `orders/detail.ts`, `invoices/download.ts`,
  `invoices/correction-request.ts`, `subscriptions/action.ts`,
  `subscriptions/preview.ts`, `payment-recovery/start.ts`,
  `payment-recovery/redeem.ts`, `payment-recovery/setup-method.ts`,
  `payment-method/setup.ts`, and `checkout-recovery/start.ts`, all exposed
  through `/api/bff/customers/…`.

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.
