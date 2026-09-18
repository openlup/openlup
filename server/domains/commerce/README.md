# Commerce Server Domain

Status: source-of-truth

`server/domains/commerce` owns HTTP-independent commerce use cases: checkout
readiness, quote/order draft orchestration, OMS mutations/read models, outbox
handlers, payment-status composition, and provider-neutral runtime ports.

## Owns

- Checkout runtime orchestration and idempotency rules.
- Order draft/finalize RPC payload mapping through domain ports.
- OMS read/mutation handlers used by admin BFF routes.
- The local-reference-only `reference.order-readback.v1` identity seam: strict
  list/detail request and response contracts plus handler ordering for the
  customer RLS and operator-governed witnesses. It returns order identity only;
  product customer/OMS read models, DTOs, status labels, and mappers remain
  outside this seam.
- Canonical completed-order money consumption for OMS, paid email, and recap;
  all three read frozen order/item columns through the browser-safe commerce
  reader and preserve catalog-line-plus-discount customer semantics.
- Read-only renewal exception projections that turn platform observability
  evidence into operator-safe commerce triage rows with local-only payment,
  cycle, order, and outbox context. These projections do not execute PSP,
  dunning, fulfillment, or customer-communication mutations.
- Commerce outbox event registry and handler contracts.
- Portable order-review grant, moderation, private-media lifecycle, raw-upload
  admission and exact-key cleanup contracts. Object keys never enter public DTOs.
- Provider-neutral ports for payment, inventory, fulfillment, and email handoff.
- Offer availability projection for configurator compatibility and
  recommendation filtering, with a static all-available default for OSS and
  provider-specific inventory mapping kept out of UI contracts.
- Acquisition offer-pricing projection built by invoking the existing quote
  port for the active catalog's minimum package. It is scoped to published dog
  recipe products (never cat products or add-ons) and exposes product-only
  one-time, initial-subscription, and recurring-subscription figures; it neither
  computes prices independently nor represents shipping/checkout/receipt truth.
  The public route pins one validity instant, coalesces concurrent projection
  reads and identical pinned price facts, rejects loads above 128 distinct
  price facts, and caches one successful value for at most five seconds from
  read start. A failed cold load has a one-second error-only backoff to protect
  the database during an outage; it never serves stale money and has no stale
  serving window.
- Mounted managed quote, batch, checkout/recovery, customer-subscription
  repricing and offer-pricing compositions share one strict current-money
  authority. It requires one exact active `one_time/min_qty=1` base entry and,
  after subscription-policy history exists, one digest-valid effective policy
  revision in the same list/region/currency/channel/instant. It never sorts an
  ambiguity into a winner. The generic tier/`any` resolver remains only for
  reference and explicitly unretired compatibility compositions.
- Recommendation/package-sizing orchestration with injected petfood policy
  seams; current defaults preserve openlup behavior while future OSS core keeps
  policy implementations downstream.

## Structural Slices

The next physical split follows the boundary in
`docs/platform/ARCHITECTURE_AND_EXTENSIONS.md`; deployment-only registry and
architecture checks verify these current slice targets:

- `checkout-runtime`: checkout readiness, resume, order finalization, payment
  status, and runtime provider-neutral ports.
- `oms`: admin order management read and mutation handlers.
- `outbox`: replay-safe commerce outbox registry, worker, and event handlers.
- `catalog-admin`: admin catalog, promotions, clone, stock-notify, and lifecycle
  operations.
- `quote`: quote, compatibility, recommendation, configurator intent, and
  order-draft pricing read paths.
- `order-review`: customer/admin handlers, direct Postgres metadata, private
  filesystem bytes, and mounted BFF/raw ingress boundaries.

### Promotion-code control plane

The v2 control plane is additive and dark. `promotion_codes` owns
case-insensitive code identity and lifecycle; `promotion_code_bindings` maps one
code to independent product and shipping benefits; `promotion_code_claims`
owns reserved/redeemed/released capacity. New benefit rows remain legacy
promotion `draft`, so the v1 quote path cannot observe them. Admin mutations
persist the definition, idempotency response and redacted audit in one RPC
transaction.

Checkout v2 is unconditional (its rollout flags were retired in PR 2243).
Single quote, batch quote and checkout use the same target-effective engine: the better of
the existing automatic product price and the code wins, product and shipping
remain separate lanes, and product payable is floored at PLN 1. Quote capacity
is advisory. The canonical order-draft transaction validates the frozen code
revision and atomically reserves capacity through its order insert trigger; a
lost race rolls the whole order graph back and checkout re-quotes as
`price_changed`. Canonical paid/cancelled/failed/expired order transitions
redeem or release claims in their existing transaction. Elapsed claim time
alone never releases capacity, a late paid callback wins after release, and a
refund never restores a use. Traffic that carries no promotion code is
byte-for-byte unchanged, and Canonical Order Money remains the sole
allocator of persisted discount money.

New automatic offer-policy v2 assignments have a separate fail-closed database
gate. `commerce_offer_policy_v2_readiness()` is service-role-only and checks the
linked first-subscription v1/v2 definitions, active 14.90/13.40 catalog band,
Bundle 5%, a fresh persisted watchdog verdict and claim sweep, bounded recent
automatic-v2 money, and every row in the operator-captured immutable
`legacy_frozen` count/fingerprint cohort with its 13.40 line/agreement
snapshots. The baseline capture RPC inserts once and never overwrites drift.
The scheduled watchdog owns the expensive full
claim/history scan; checkout reads only its small persisted verdict. Positive
results are cached for at most 60 seconds; negative, malformed, or failed reads
for at most 5 seconds. Quote, batch quote, offer-pricing and checkout share this
authority. A valid existing visitor-bound assignment token is honored before
readiness is read, while new work falls to v1 whenever readiness is not green.
When `COMMERCE_OFFER_POLICY_V1_FALLBACK_DISABLED=true`, the compatibility
fallback is removed: missing capability/config/readiness, a partial cohort, or
a bound v1 token fails closed instead of producing v1 money. This gate controls
new browser assignments only; persisted `legacy_frozen` subscription renewals
and mutations retain their frozen policy.

## Does Not Own

- Browser contracts and clients: `src/domains/commerce`.
- Route/auth/rate-limit composition: `server/bff/commerce` and
  `server/bff/admin/commerce`.
- Provider HTTP/env/signature code: `server/infra/*`.
- Provider execution adapters: `server/adapters/*`.
- Durable schema authority: `supabase/migrations/*`.

## Sharp Edges

- Checkout payment/provider paths must fail closed unless their registry flags
  are explicitly enabled.
- Outbox handlers must be replay-safe and must not log buyer payloads, provider
  payloads, tokens, or service-role details.
- Supabase writes must happen through domain-owned ports or RPC helpers, with
  deployment-only rehearsal probes and the public hosting boundary in `docs/platform/RUNTIME_AND_SELF_HOSTING.md`.
- Configurator stock visibility must flow through the provider-neutral offer
  availability port; UI components should receive ready statuses, not import
  inventory providers or reimplement ATP logic.
- Single and batched configurator quotes must compose the same persisted
  commerce settings port so delivery policy cannot drift between tiles and
  checkout.
- Strict D1 money paths may use legacy subscription entries only while their
  exact policy context has no policy history. Once history exists, a missing,
  overlapping, invalid or digest-mismatched policy is a named refusal; it must
  never reopen legacy fallback. Policy-derived subscription lines persist
  server-only `catalog_facts_v2` provenance, while historical v1 snapshots stay
  readable and unchanged.
- Checkout stock holds are leases. Availability and reservation paths count
  only `status='reserved'` rows with `expires_at IS NULL` or `expires_at > now()`;
  cleanup jobs may remove old rows, but they are not part of stock correctness.
- A real-provider checkout becomes compensation-ineligible when the durable
  prepared attempt crosses into provider dispatch. Execution, attempt
  finalization, decline finalization, readiness, and response-shaping failures
  after that boundary preserve the order and stock hold and surface the typed
  in-flight recovery state. Do not widen generic checkout compensation across
  that boundary.
- The promotion acceptance token binds **money, not presentation**.
  `promotionQuoteBinding.ts` owns the one canonical projection both surfaces
  hash — currency, the five totals, shipping and its discount, per-line
  sku/quantity/unit and line gross plus the VAT rate and split, and per-discount
  amount and identity (`promotionId`, `appliesTo`, `promotionCodeId`,
  `promotionDefinitionFingerprint`, benefit kind and value). Everything else is
  deliberately unbound: labels, `reasonCode`, `customerSemantic`, the raw code,
  `promotionCodeRevision`/`Scopes`/`ValidTo`, `promotionMinimumReferenceMinor`,
  `floorApplied`, `context`, `codeRejections`, `pricingComponents` and
  `catalogFacts`. That last one is why: the quote route signs the public
  projection with `catalogFacts` stripped while the checkout guard verifies the
  raw server-authoritative quote that carries them, so hashing the whole quote
  rejected every strict-path v2 code checkout. The token additionally carries an
  optional per-section HMAC so a `quote_mismatch` reports `mismatchField`
  (`lines|discounts|shipping|totals|currency|other`, `other` for a token minted
  before the sections existed) in the acceptance telemetry. Legacy tokens
  still parse but use the former whole-quote hash, so the new verifier rejects
  them as `quote_mismatch`/`other`. The quote handler refreshes them by issuing a
  new money-bound token; unchanged payload version does not promise acceptance
  of the old hash.
- `commerce_runtime_finalize_journey_consumed` is valid only when the completed
  finalize row points to an existing terminal/non-resumable order. A completed
  finalize row for `draft` or `pending_payment` remains a generic, non-rotatable
  conflict. Do not infer order lifecycle from idempotency-row status.

## Before Changing

Read `docs/platform/ARCHITECTURE_AND_EXTENSIONS.md`,
`docs/platform/RUNTIME_AND_SELF_HOSTING.md`, and
`docs/platform/CANONICAL_CONTRACTS.md`. For checkout/runtime work, also inspect the deployment's provider history and deployment-owned SQL probes.
