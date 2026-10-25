# commerce domain

Core ecommerce engine: cart/basket, recommendation, product compatibility,
offer availability projection,
quote, order-draft, checkout runtime saga, OMS read models, payment-status
bridge, subscription checkout metadata, and idempotency shell. The hidden
one-time/subscription-initial checkout lives here.

## Owns / does not own
- **Owns:** cart, checkout, recommendations, product compatibility, orders,
  payment orchestration, subscription linkage, discounts, idempotency shell,
  order-draft outbox event contracts, OMS read models, and the checkout
  `invoicePreference` contract that writes the final order buyer snapshot.
- **Does not own:** product copy (`catalog`), DHL provider details
  (`fulfillment`/`server/infra`), Supabase/provider adapters, or invoice issuing
  policy/provider execution (`accounting`).

## Commerce contracts package boundary

`@openlup/platform/commerce` remains browser-safe. The separate experimental
`@openlup/platform/commerce/server` entry owns the unchanged checkout compensation
helper and its cleanup port. The reference compensation path re-exports the same
function, so existing orchestration and adapter imports keep their identity.
Cleanup releases the order's reservations before promotion cancellation and,
when needed, abandoned-order cancellation; keys, reasons and warning/failure
behavior remain unchanged. Host schema, subject, fiscal, starter policy, payment execution and concrete persistence bindings
retain their reference owners. Lint refuses browser commerce imports of the
server subtree, and package tests bundle the browser entry and exercise the
installed server helper.

Neutral commerce schemas and ports come from `@openlup/platform/commerce`
and its type-only `/contracts` entry. Their runtime graph is browser-safe;
`@openlup/platform/commerce/server` supplies Node-only OMS handlers, managed
adapters and order-detail composition. Canonical order-money validation and commerce outbox payload validators
also delegate to the browser-safe package. Payload validators reuse the core
outbox envelope and inject the reference quote/draft schemas; snapshot matching
and aggregate identity refusals remain unchanged. Cart/order/read, checkout, configurator,
persistence, resume and customer-default bindings compose package cores with
reference locale, profile and sizing, fiscal and provider schemas. Pricing
DTOs come directly from `@openlup/platform/pricing/contracts`; commerce contracts
have no pricing edge. Generic quote ports bind the existing pricing request,
response and options types in the reference, retaining its named exports
without introducing a pricing edge into commerce/contracts. The commerce
runtime reuses the version constant from pricing/contracts.
Existing reference exports retain their names and host
validation; unchanged suites and the pre-extraction equivalence transcript check
parsed output and complete error paths. Core and host fields retain their legacy
positions, preserving issue order for missing or simultaneously invalid fields
in intents, nested variants and checkout requests. The BASE-captured repair
transcript checks those refusals and the other composed schemas; type assertions
keep SKU, currency and product-slug inputs as strings across the exported
reference schemas. The repair regression also compares generated multi-error
transcripts against BASE goldens for every exported schema in these bindings.

Availability projection requests one unit per variant in order. Recovery,
nominal errors, delivery-contact projection, reference stripping, diagnostic
messages and fulfillment eligibility delegate to package definitions. Checkout
orchestration retains the local profile and invoice mappings and forwards an
optional acquisition capability. Checkout expectations admit acquisition terms
independently of totals. Configurator offer versions/minimums are untrusted asks;
a supplied minimum replaces only the local intent-validation default. Checkout
admission retains the host minimum and refuses offer/minimum asks when no server
offer resolver is composed. With a resolver, the offer-policy port binds or
refuses explicit asks before quoting and stores bounded evidence after acceptance;
starter admission injects the reference terms and arithmetic. None of these
changes activates an issuer or provider.

The server entry also owns checkout admission, quote/resume/failure handling,
the runtime and the single paid-order saga shared by configurator and neutral
command mappings. Thin reference factories supply the incumbent schemas, BFF
responder, observed request identity, subject projections, M07 callables and
application destinations. Provider roles, flow policy and trusted provider-evidence
classification stay in those bindings. Saved-method alias/recurring unions remain
reference-owned type arguments; the package forwards their values unchanged. Shipping/acquisition quote acceptance, bound offers,
saved-epoch continuation, scoped busy refusal and injected starter terms follow
the change fragment. Neutral conformance covers paid, changed-price, stock-loss,
decline and busy outcomes; reference suites retain host schema/policy proof.
Concrete stores and recovery remain reference-owned in this phase.

The OMS handlers, operational ladder, read builders and managed RPC translations
now delegate to the same commerce package. Browser-safe schemas and pure models
use commerce; handlers, managed stores and detail composition use commerce/server.
Reference schema extensions retain
identity and fiscal fields; read composition supplies provider projections,
settlement policy and presentation through injected seams. Administrative read
governance still gates before hydration and audits before masking. Manual refund
marking records an operator fact only. Replacement creation delegates to the
existing fulfillment package handler; its order RPC creates a parcel obligation
without changing subscription lifecycle or confirming delivery alignment.

Returns, native review/media and hosted-feedback handlers and adapters come
from `@openlup/platform/commerce/server`. Browser-safe schemas and pure helpers
remain at `@openlup/platform/commerce`, alongside type-only port declarations.
Existing server and browser paths are thin facades; returns handlers inject the
observed BFF responder. Returns stop at
request/approve/reject: restock and refund fields record intent, with no receive,
restock or refund execution. The request adapter forwards `requestedBy` unchanged;
database ownership and replay checks retain their authority.
The package returns schema now defaults to neutral reasons; the reference facade
binds its complete legacy reason set and passes that schema to the customer
handler. BASE-captured observations pin every accepted reason, normalized input,
unknown-code error details and handler response.

Native review customer/admin handlers retain their result envelopes and error
mapping, including exact replay-field presence. The PostgreSQL adapters validate
native receipts, and raw uploads use the existing capability/lease seam. Runtime
composition and the private filesystem object store stay host-owned; M02 blob
storage lacks the private read/inspect/temp/promote operations needed to replace
that store unchanged. Hosted token feedback remains a separate lifecycle, for
adopters providing its two managed RPCs; native `db/platform` has no hosted-feedback
RPC and the reference app adds no feedback route. Review delay remains SQL-owned
(14 days native, 21 in the contributed managed profile), without a TS seam.
Package conformance covers exact returns RPC arguments, replay/error carriage,
strict feedback schemas and the four review/media visibility receipt cases.
Browser review and feedback facades import the jitless Zod wrapper before the
package entry. Fresh-process tests pin zero Function probes for both, with
wrapper-bypass controls, independently of the parent test registry's configuration.
Browser bundles resolve the complete commerce entry and both facades without
externals or Node/database imports. The server entry bundles for Node; raw
uploads deliberately fail the browser negative control.

## Commerce domain effects package boundary

The reference transactional email handlers and dispatch registry bind the single
implementation at `@openlup/platform/commerce/server`. Pure projections and ports
remain at the browser-safe `@openlup/platform/commerce` entry. The package consumes durable
outbox facts; existing database triggers, the outbox worker and the independent
accounting invoice duty retain their owners. Paid email and paid fulfillment
register independently. Fulfillment delegates to M08, including its optional
risk gate. Cancellation email remains unregistered; accounting may claim its
fact through `extraHandlers`. Return approval and rejection notify only their
own facts, without performing goods receipt, refunds or subscription changes.

`commerceEmailBinding.ts` retains locale, money/line labels, first-subscription
presentation, legacy tracking and provider notification policy. It binds the
existing fulfillment payload parser, communications transactional scaffold and outcome mapper
without moving those algorithms into commerce. Reference field names and send
ordering are preserved; neutral ports use `contextName` and `messageId`.
Refund emails show an amount only for `provider-refund.v2` evidence. Paid receipt
presentation forwards its proved discount percentage. Registry descriptors are
checked against actual registration before claim.

The neutral sales-channel projection retains source kind, channel slug and
external order reference byte-exact. OMS keeps its existing richer projection, where an unread source axis stays undefined. Inventory
exposure is a type-only injected read port, with no SQL or default binding.
W8/W9 conformance lives in `packages/platform/test/commerce/effects`; rebound
reference suites and the captured event-schema transcript check host behavior.
Admin order UI and marketing/review handlers remain reference-owned.

### W8/W9 conformance: dropped adopter-private assertions

The package suites retain neutral consumer behavior and source identity while
the donor's deployment inventory and migration lineage stay with their owners.

W8 (`commerceDomainEffects.test.ts`) omits these assertions:

- Paid-purchase analytics descriptor event type (`commerce.order.paid.analytics`)
  and its exclusion from the core registry: private M13 analytics.
- Paid-purchase measurement trigger mechanism: private M13 analytics.
- Draft-created catalog runner/business-trigger match: deployment-specific trigger inventory.
- Accounting invoice-producer catalog runner match: deployment-specific trigger inventory.
- Fulfillment-handoff invoice-duty business-trigger match: deployment-specific trigger inventory.
- Order-canceled emission catalog runner/business-trigger match: deployment-specific trigger inventory.
- Return-emission catalog runner/business-trigger match: deployment-specific trigger inventory.
- Eleven sealed migration SHA rows, witnessed function/trigger/table catalogs and
  `assertMigrationWitness`: adopter append-only migration lineage; pgTAP suites own runtime emission proof.

Consumer and flag assertions retain neutral duty independence. M09 owns invoice
execution; the package registry remains a consumer map.

W9 (`commerceSalesChannelSeam.test.ts`) omits these assertions:

- Two exposure/new-purchase migration SHA seals, witnessed-object catalog and `assertMigrationWitness`:
  adopter append-only migration lineage, owned by M10/M06.
- Regex for `inventory_listing_exposure(p_sku_id uuid)`: M10/M06 exposure SQL ownership.
- Issued-minus-converted-minus-withdrawn listing-unit SQL text: M10/M06 exposure SQL ownership.
- Raw-sellable-minus-listing-exposure regex: M10/M06 ATP/exposure SQL ownership.
- Pending-symbol migration-lineage absence witness: M10/M06 migration ownership;
  replaced by package-source absence of `inventory_channel_exposure_quantity`
  and the type-only injected `CommerceChannelExposureReadPort`.

## Pricing policy package boundary

The existing pricing-policy token and neutral error/safe-reason block are owned
by `@openlup/platform/pricing`; the reference server files retain named exports
of the same classes and functions. `commercePricingPolicy.ts` still composes
feature flags, the signing secret and readiness, including historical-token
honoring and cutover refusals. `offerPolicyContracts.ts` imports package version
constants and DTOs but retains the browser's local Zod schemas. The pricing package also owns neutral money/tax/quote and offer DTOs, portable
validation, provenance, quote computation/helpers, snapshot comparison, quote/batch
handlers, offer projection/handler/cache and readiness. Reference server wrappers
bind settlement defaults, flat shipping through `getShippingFlatMinor`, promotion
application, rich context/reconstruction, roster/request/unit/floor/scope policy and
the observed BFF responder. Browser validators retain the existing request/context
admission and industry wire scopes. The strict quote context additionally admits
optional shipping and resolved acquisition terms through the identical existing
validators re-exported by `@openlup/platform/pricing/browser`; absent terms retain
the existing parsed output. Existing ordering, VAT equations, v1/v2 offer
responses, errors and TTL rules are preserved. Promotion application and acceptance
now live in `@openlup/platform/promotions`; named server wrappers retain local policy.
The module also owns promotion admin handlers, ports, dependency-free DTOs, server
schemas and the native read/sweep store. Wrappers pass the existing admin kit,
error constructor, response/preview helpers and currency validator by reference.
Human write authorization, required audit, system-managed read-only rows and
status-only mirrors keep their prior behavior. Shipping, catalog-price and
subscription-band schemas, managed adapters and claim writing retain their owners.

The experimental pricing acquisition API is available only through explicit
host composition. The reference binds no acquisition configuration and retains
its existing offer, quote and readiness lanes. The two acceptance helpers accept
optional server-selected resolved terms: they bind the full object, including
its source identity, in the whole money projection and existing totals section.
Terms alone permit low-level token issuance and verification. Without that
explicit input the projections omit the property and the signing envelope,
section order, eligibility and historical token bytes are unchanged. This does
not activate a route issuer or change checkout admission; acquisition-only
mounted-route issuance remains pending composition evidence.

## Reference browser promotion schemas

`adminPromotionsContracts.ts` and `adminPromotionCodesContracts.ts` define the
browser validators locally. They use the core promotion enums, local settlement
validator and pricing contracts version; neither imports the promotions server
entry. Server schemas and DTOs retain their existing package owner. The
[admin binding proof](../../../tests/platform/promotions/adminBinding.test.ts)
compares parse acceptance, errors and output (including trim, defaults, stripping
and strict objects), checks DTO compatibility and bundles the actual clients and
value-importing dialogs with positive local-schema controls. Shipping rates,
subscription bands and catalog-price inputs keep their existing semantics.

## Promotion application package boundary

The experimental [promotions module](../../../packages/platform/README.md#promotions)
owns quote application, benefit interpretation, read ports, preview, money binding,
acceptance and passive recording. Reference wrappers retain the module-load floor,
customer classifier, email/contact eligibility precedence, request projection and
sanitized recorder. The existing core promotion evaluator remains the authority.
Read-only quotes and advisory code resolution never reserve capacity; managed RPC
transport, admin and durable claim writers retain their existing owners.
The pricing handler supplies resolved acquisition terms to both acceptance callbacks
as a final optional argument. No reference acquisition configuration is added, and
the fixed historical token witness still protects absent-terms bytes. Native and
acquisition-only mounted acceptance remain pending composition evidence.

The reference customer and admin promotion classifiers require the host's legacy
first-subscription percentage as an explicit argument, with no default. The
reference quote-discount composition owns the named incumbent value; the v2 quote
composition and admin adapter pass that same value. This keeps classification,
comparison tolerance, system-managed read-only rows and quote money unchanged
while keeping adopter policy out of the classifiers. No package export changes.
The managed baseline's legacy-mirror predicate remains immutable; changing its
incumbent value requires a forward migration, recorded as an M05 follow-up
needing an owner decision in the
[M05 ledger](../../../docs/platform/plans/oss-m05-catalog-offers-pricing.md#p6-acceptance-obligation).

## Public surface (import cross-domain ONLY these)
- UI/BFF clients: `commerceClient.ts`, `omsClient.ts`,
  `adminPromotionsClient.ts` (admin "Rabaty" editor),
  `adminCatalogClient.ts`, and `customerEligibilityClient.ts`.
- Public contracts/helpers: `checkout*`, `quoteContracts.ts`,
  `offerPricingContracts.ts`, `useCommerceOfferPricing.ts`,
  `adminPromotionsContracts.ts`,
  `orderDraftSnapshotContracts.ts`, `runtimeContracts.ts`, `recommendation*`,
  `productCompatibility*`, `offerAvailability*`, `paymentStatus.ts`, `oms*`, `configuratorIntent*`,
  `customerDefaultsSnapshotContracts.ts`, `outboxEventContracts.ts`,
  `contractPrimitives.ts`, and `basketSizeConstraint.ts`.
- Frozen completed-order money seam: `orderMoney.ts` exports shared select
  columns and `deriveOrderMoney()`. It validates persisted catalog, allocated,
  effective, VAT, delivery, and total equations but never allocates a discount
  or reads quote metadata as completed-order truth.
- Public acquisition prices use the versioned offer-pricing projection for
  eligible published products. When the v2 capability flag is enabled, the hook
  binds the request to the app-level first-party visitor id; without that id it
  stays amount-free and fail-closed. Transactional totals still come only from
  the quote contract, and historical receipt totals only from canonical order recap.
- Ports/types: `ports.ts`, `runtimePorts.ts`, `omsPorts.ts`, `types.ts`.
- Pure policy helpers: pricing breakdown, recommendation engine/variant
  selection, recommendation policy contracts, offer availability derivation, and OMS fulfillment
  eligibility/summary (`pricingBreakdown.ts`, `omsFulfillment*`).
- Adopter-specific product policies live downstream in a deployment-owned module,
  which is withheld by the deployment overlay and is not part of the published
  tree. `energyPolicy.ts` keeps only compatibility type exports and
  `packageQuantityPolicy.ts` keeps the package policy contract/version exports;
  a published tree binds its own implementation of those contracts at the
  composition root.
- Transactional email *content* (commerce owns the copy; chrome/transport live
  in `communications` + `server/infra/resend`): `emails/*` — e.g.
  `emails/orderDraft.ts` builds the localized order-draft resume nudge as
  blocks. Consumed by the outbox dispatch adapter, not imported cross-domain.
- The paid-order receipt takes one optional, already-localized `parcelNote`,
  rendered as a single paragraph right after the item list. It is plain text
  in which the paragraph block's inline bold and link markers still apply, so
  a note should avoid them. Commerce never composes it: a composition may give
  the registry `transactionalEmail.orderPaidParcelNote`, which the order-paid
  handler receives as `describeParcel` and calls at send time, within its
  timeout, with the order id and the recipient's locale. A null or empty
  answer, or a failure, sends the receipt without the note; a failure is
  logged. Without the reader the receipt is unchanged.

Everything else (handlers, orchestration, `dbBacked*`/`supabase*` ports) is internal.

The catalog-backed quote and recommendation readers take each SKU's stored
one-time and subscription sellability from the catalog read port: a quote
refuses a line in a mode its SKU is not sellable in, and a recommendation leaves
such a SKU out of that mode. A catalog source that states no sellability counts
as sellable in both modes.

Neutral outbox envelope/handler contracts and the dispatch engine are consumed from the core/outbox packages. Commerce keeps business handler composition and event ownership. Registry composition still preserves nested results, effective summed timeout and retry replay; the explicit known vocabulary remains distinct from the enabled registry.

## Where the code lives
- Shared/frontend: `src/domains/commerce/`
- Server (handlers, orchestration, Supabase ports, runtime saga): `server/domains/commerce/`
- BFF public URLs: `/api/bff/commerce/...`, `/api/bff/admin/commerce/...`
- BFF handler files: `server/bff/commerce/...`, `server/bff/admin/commerce/...`
  via the catch-all Vercel entrypoint `api/bff/[...path].ts`

## Admin discounts and promotion codes
The "Rabaty" admin surface separates automatic promotions from Code Center.
The legacy promotion list is a semantic read model: raw technical values are
not returned, and rows linked to v2 mirrors are system-managed/read-only in both
the UI and service-role adapter. Editable legacy rows and subscription/catalog
pricing mutations are unconditional behind admin auth (the `COMMERCE_PROMOTIONS_MUTATIONS_ENABLED` launch flag was removed in release-gates-w7).

Code Center list, preview, create and update are unconditional behind admin
auth: the five rollout flags were retired in PR 2243 after the feature went
permanently live. Create/update additionally require a human actor. Automatic
offer-policy rollout is still a separate control and is not implied here.

Domain-boundary rules, including the Domain Map and the feature trace, live in
the maintainer canon `DOMAIN_ARCHITECTURE.md`, which belongs to the private
overlay and is not part of the published tree.

<!-- openlup-doc-impact {"unit":"domain-commerce","digest":"sha256-6cc6ab0e0b1a42162aa3fec7747a6bebfa36ee5afa02b1969358017267e8d6bb","reason":"Email tests select neutral content and explicit presentation fixtures; operational-ladder checks resolve current installed state instead of historical source spelling. Money, idempotency, durable order ownership and email composition code described here are unchanged. The checkout and configurator-intent handlers lose their never-injected optional personalization hooks, and the personalization cookie mint is deleted; checkout money, idempotency, order ownership and the persisted response are unchanged."} -->

Commerce email facades now bind the pure communications/contracts content
factories. Copy packs, reference formatting, signed unsubscribe/footer policy and
brand composition remain here. Legacy optional `petName` maps to `contextName`
only at the facade; subjects, preheaders, ordered blocks and full rendered output
remain unchanged. The public template parity suite covers both locales and
optional receipt, tracking, return, CTA and marketing branches.
