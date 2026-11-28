# Read prices for a quote

Compose a PostgreSQL price reader with the price authority to resolve current
quote amounts from stored price and subscription-policy histories. Supply the
installation's restricted runtime executor; the reader does not choose prices,
discounts or rounding policy for you.

## Resolve prices and adjustments

Core's `PricingResolverPort` from `@openlup/core/pricing` resolves price-list
entries asynchronously. Your adapter owns fallback choices; a missing entry
returns `null`, which your caller must report rather than silently quoting free
products. The pure breakdown builders turn supplied resolved prices, discounts
and shipping into line and order components whose sums reconcile to the totals.
They do not read prices or persist an order.

For already validated position money, `cataloguePositionNetFromGross` derives
included-VAT net using integer arithmetic. Supply a nonnegative safe integer
gross amount and an integer rate from 0 to 10000 basis points. The existing
`@openlup/core/pricing` subpath also exports
`allocateCatalogueDiscountedGrossTotals`: supply gross position amounts and the
charged total to receive effective gross amounts. Equal remainders follow input
position, so preserve the original order. Tax and currency selection stay with
the caller. Existing quote paths retain their arithmetic until a caller
explicitly composes these helpers.

Opt in to experimental money v2 with resolved prices, adjustments and tax inputs in one minor unit.

```ts
import { calculateCatalogueMoneyV2 } from "@openlup/core/pricing";

const ref = { kind: "merchandise", lineKey: "item", sourceOrdinal: 1 } as const;
const { payableMinor } = calculateCatalogueMoneyV2({
  amountBasis: "exclusive",
  sources: [{ lineKey: ref.lineKey, sourceOrdinal: ref.sourceOrdinal, quantity: 2, unitBasisMinor: 500 }],
  delivery: [], adjustments: [], fees: [],
}, { kind: "local", components: [{ ref, rates: [
  { positionRef: "tax", jurisdictionRef: "district-a", rateDecimal: "8.125" },
] }] });
// payableMinor === 1081
```

Local tax rounds the sum of exact position quotas half up per component state.
Floor each quota and assign leftover minor units by largest fractional remainder,
with ties by ascending `positionRef` in UTF-16 code-unit order.

For provider tax on exclusive amounts, call `planCatalogueMoneyV2` first. Supply
the initial state and each nonzero adjustment state in order for each component,
plus the provider payable including fees. See `CatalogueMoneyV2Tax` for the state
fields and an example. For inclusive amounts, supply rates for merchandise and
handling. Shipping inherits rates from its merchandise shares.

For promotion candidates, `evaluatePromos` from `@openlup/core/promo` checks
active time windows, region and cart eligibility, including coupon codes and
stacking rules. Order discounts and free shipping use separate lanes.
`evaluatePromotionAdjustmentsV2` selects product and shipping adjustments and
returns payable amounts and rejected-code facts. These pure evaluators supply
no persistence or checkout activation. Use the database ports below when your
quote needs stored prices and promotion facts.

## Compose a request scope

Import `createPostgresCommercePriceAuthorityReadPort` from
`@openlup/platform/commerce/server/postgres` and
`createConcurrentCommercePriceAuthorityPort` from `@openlup/platform/pricing`.
The executor implements `PgQueryExecutor`, imported as a type from
`@openlup/platform/data`.

For each request, pass the executor to the PostgreSQL factory, then pass the
returned `CommercePriceAuthorityReadPort` to the concurrent authority factory.
Call the resulting port's `resolvePrice` with the variant, region, currency,
channel, purchase mode and optional `atTime`. Without `atTime`, resolution uses
the current time.

The read scope shares raw histories and batches entry reads. Allocate it once
per request and discard it afterwards: it retains successful and failed reads,
so reusing it across requests can preserve stale data. Effective intervals and
policy digests are checked during each resolution.

## Preserve the price history

The read port exposes `listPriceLists`, `listExactBaseEntries`,
`listExactLegacySubscriptionEntries` and `listSubscriptionPolicyHistory`.
The PostgreSQL implementation reads active lists and active entries with an
exact base-quantity constraint, retaining their validity intervals. Consult the
[API report](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/platform/api/commerce-server-postgres.api.md) and its linked implementation
for the selection constraint. Policies
are scoped by list, region, currency and channel.

Resolution requires a unique effective list and a unique gross base entry.
One-time purchases use that base. Subscription purchases use a validated,
effective policy revision to derive the amount. Legacy subscription entries
are considered only when the policy history is empty; an existing history
with no effective revision does not fall back to legacy pricing.

Use this authority for current quote money. Keep frozen renewal obligations
on the subscription path; do not replace their saved money with a new quote.
See the [pricing reference](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#pricing)
for the surrounding contract.

## Price a fixed one-time offer

Resolve the authorized offer and its exact physical lines on the server. Use
Core's `allocateBundleTargetPrice` when the offer has a target total. Pass the
allocated unit amounts in the strict quote port's second argument, under
`oneTimeOfferPricing` with `priceReference`, `currency` and `lines`. Each
allocation line carries `sku`, `quantity` and `unitGrossMinor`. The reference
identifies the price revision in your own authority. Quote the full set of
unique SKUs in one currency, at uniform exact unit money for each SKU. An
allocation whose unit groups differ for the same SKU requires a separate,
compatible downstream representation. Never use a rounded average. The
server refuses invalid, incomplete and above-retail allocations. The existing
catalog still controls sellability and retail reference amounts, including for
promotion eligibility. The authoritative snapshot keeps offer price provenance
private and the public quote projects it out.

For explicit confirmation even without an adjustment, compose
`createPromotionQuoteAcceptance` from `@openlup/platform/promotions` with
`purpose: "offer-review"`. Give the issuer and verifier the same canonical
projection of server-resolved offer revision, any separate price revision,
checkout journey and delivery choice. The token already binds actual SKU quantities, line money, discounts,
tax and shipping. Set `requireQuoteAcceptance: true` when the host offer
policy binds the offer. Implement its `verifyQuoteAcceptance` method with the
offer-review verifier, using the authoritative offer version passed to it.
Offer-review tokens have their own signing domain. Keep the token transient
and apply existing checkout and recovery admission. Re-resolve the offer before
taking a new payment. The application owns offer eligibility and recovery UX.
Any standalone snapshot verification or expired recovery for this offer needs
the same server-bound re-quote. Standard checkout skips generic cross-order
matching for an offer that requires review. Use the accepted order's own
journey for payment continuation.

## Accept a final v2 quote

Use the experimental server helpers in `@openlup/platform/promotions` to bind
a final quote to the all-in payable and every fee shown to the customer.
At presentation and submit, build `QuoteAcceptanceScopeV2` from the
authenticated customer and the final quote loaded through the owner-scoped
evaluation. Derive `requestDigest` consistently from the owner, checkout scope
reference and quote ID. Keep the signing keyring on the server and supply an
integer Unix-millisecond clock. Before issuing, the host presentation path
qualifies current payment limits and supplies the recurring acceptance
reference when required.

Pass the values shown to the customer as `presentation`, including the quote
digest, all fee keys and the payable amount and currency. Mint an opaque
`acceptanceRef` on the server. Return the issued token and `presentationRef`
for the browser to echo at submit.

```ts
import {
  issueQuoteAcceptanceTokenV2,
  verifyQuoteAcceptanceTokenV2,
  type QuoteAcceptancePresentationV2,
  type QuoteAcceptanceScopeV2,
} from "@openlup/platform/promotions";

export function issuePresentedQuote(
  scope: QuoteAcceptanceScopeV2,
  acceptanceRef: string,
  presentation: QuoteAcceptancePresentationV2,
) {
  return issueQuoteAcceptanceTokenV2({ ...scope, acceptanceRef, presentation });
}

export function verifyPresentedQuote(
  scope: QuoteAcceptanceScopeV2,
  token: unknown,
  presentationRef: unknown,
) {
  return verifyQuoteAcceptanceTokenV2({ ...scope, token, presentationRef });
}
```

On success, use the authenticated `acceptanceRef` and other signed claims from
verification. The echoed `presentationRef` checks that the browser is
submitting the same presentation. Token authentication and quote binding
provide the integrity check. The host owns what its UI displays. The token
contains readable signed data. Keep it transient and out of logs, and use
opaque references for customer and acceptance identities.

| Code | Remedy |
| --- | --- |
| `quote_acceptance_mismatch` | Re-obtain valid acceptance from the authorized presentation path. |
| `mandatory_fee_requires_all_in_display` | Present the full payable and applicable fees and obtain fresh acceptance. |
| `quote_acceptance_expired` | Obtain a fresh final presentation and acceptance. |

## Handle refusals

Catch `CommercePriceAuthorityError` from `@openlup/platform/pricing` and use its
`code` to distinguish the cause. Correct the stored history or request context
before trying again; choosing the newest overlapping row would hide the error.

| Condition | Code |
| --- | --- |
| No effective list, or overlapping lists | `active_price_list_not_found`, `active_price_list_ambiguous` |
| Missing or overlapping exact base entry | `base_price_not_found`, `base_price_ambiguous` |
| Base entry is not gross | `base_price_amount_kind_invalid` |
| Missing or overlapping legacy subscription entry | `legacy_subscription_price_not_found`, `legacy_subscription_price_ambiguous` |
| Policy history exists but has no unique effective revision | `subscription_price_policy_not_effective`, `subscription_price_policy_ambiguous` |
| Policy validation or digest check fails | `subscription_price_policy_invalid`, `subscription_price_policy_digest_mismatch` |

When using `createDbBackedCommerceQuotePort`, a price-authority refusal is wrapped
in `CommerceQuoteError` with `code: 'PRICE_NOT_CONFIGURED'`; its
`details.reason` retains the price-authority code above. Preserve only an exact
allowlist of these reasons at your host boundary. Do not return the exception
message, arbitrary details, database queries or provider payloads to the browser.
Unknown failures should show a generic unavailable-price message.

The starter supplies English and Polish reason-and-repair copy in
`owned/quote-copy.ts`. Missing base prices require an effective **one-time gross
base entry**, including for subscription quotes. Correct missing or overlapping
lists and entries for the requested market, currency and channel; repair invalid
policy revisions and digests through the price authority's writer. A policy
history with no effective revision needs corrected effective dates, not a legacy
fallback.

Existing `purchase_mode_unavailable` and `cadence_unavailable` refusals ask the
reader to choose an offered mode, product or interval. A subscription quote in
the database-free starter preview returns `host_binding_required`: run
`./lifecycle up` from the prepared application to install and bind the local
demonstration, then refresh. One-time estimates remain available in that preview;
installed quotes serve both purchase modes. These diagnostics change no prices,
purchase-mode eligibility or subscription terms. During a refresh, the starter
withholds the previous amount; a failure or a late superseded response cannot
restore it.

## Add advisory promotion reads

If the quote also evaluates promotions, import
`createPostgresCommercePromoDataPort` from `@openlup/platform/promotions` and
pass the runtime executor. It reads active definitions, paid-order counts,
counts by purchase mode, redemption counts and device first-order evidence.

The native device routine returns `false` because it has no persisted visitor
identity. Redemption counts group by promotion identifier and do not combine
related promotion families. Treat these reads as advisory; a false device
result does not establish first-order eligibility.

## Compose native quotes on the server

Bind the experimental quote port in a native app after installing and
inspecting the qualified payment rail. Use the same privacy contributor registry
as the app's privacy handlers, including during issuance rollback. Bind the
destination port and a restricted tax transaction lane. The host supplies a
basis-aware plan for the ordered basket, its delivery and catalogue evidence,
the selected rail and bounds, and the applicable fiscal profile or tax adapter.

```js
import { bindCommerceMoneyLimitsV2Reader, createDbBackedCommerceQuotePortV2, readPublishedSkuTaxAssignments } from "@openlup/platform/commerce/server";

export function bindNativeQuotes({ runtime, ...bindings }) {
  return createDbBackedCommerceQuotePortV2({
    ...bindings,
    readLimits: rail => bindCommerceMoneyLimitsV2Reader(runtime, rail)(),
  });
}

export function withPublishedTaxClasses(runtime, readFacts) {
  return async (owner, request, document) => {
    const { facts: hostFacts, skuIdsByCode } = await readFacts(owner, request, document);
    const { planInput } = hostFacts;
    if ((planInput.listBasis ?? "inclusive") !== "exclusive") return hostFacts;

    const facts = { ...hostFacts, planInput: { ...planInput, lines: planInput.lines.map(line => ({ ...line })) } };
    const pairs = new Map();
    for (const { sku } of facts.planInput.lines) {
      const skuId = skuIdsByCode.get(sku);
      pairs.set(JSON.stringify([skuId, sku]), { skuId, sku });
    }
    const { assignments } = await readPublishedSkuTaxAssignments(runtime, {
      expectedSelectionDigest: null, skus: [...pairs.values()],
    });
    const bySku = new Map(assignments.map(row => [row.sku, row]));
    const lines = facts.planInput.lines.map(line => {
      const { taxClassKey, assignmentRef } = bySku.get(line.sku);
      return { ...line, taxClassKey, assignmentRef };
    });
    return { ...facts, planInput: { ...facts.planInput, lines } };
  };
}
```

The wrapper captures the SKU set and top-level catalogue evidence before reading
the assignments. The host is responsible for in-place changes to money evidence
such as `price`, just as on the direct quote path.

On the exclusive route, pass `withPublishedTaxClasses(runtime, readFacts)` as
`readPlan`. Return the plan `facts` and a `skuIdsByCode` map from the host's
trusted selection in `readFacts`. Use the restricted native runtime connection.
Each merchandise assignment reference binds the exact SKU set and the verified
current publications for that selection. Pass a known `expectedSelectionDigest`
to pin it, or pass `null` to bind the current selection. Corruption in a selected
product refuses the quote. Unrelated corruption leaves the quote available, and
`catalog_publication_read_head()` still refuses when the catalogue-wide check
finds inconsistent evidence. The host supplies delivery assignments and fiscal
facts.

| Refusal | Field | Next action |
|---|---|---|
| `tax_invalid_input` | `/plan/skus` or `/plan/expectedSelectionDigest` | Supply the documented published SKU selection and its selection digest, then repeat the read. |
| `catalog_tax_assignment_evidence_invalid` | `/plan/skus` | Have the catalogue owner reconcile the original selection and publication evidence, then repeat the read. |
| `catalog_tax_assignment_head_changed` | `/plan/expectedSelectionDigest` | Read the published selection again and request a fresh quote. |
| `catalog_tax_assignment_unpublished` | `/plan/skus` | Choose published merchandise or have the catalogue owner publish the intended SKU, then request a fresh quote. |
| `tax_class_missing` | `/plan/skus` | Choose published merchandise whose product type declares an active tax class, or have the catalogue owner publish replacement merchandise with such a type, then request a fresh quote. |

Call `createQuote` with the trusted linked customer and checkout scope. Reuse the
same key and invocation to read the original evaluation. A pending result directs
you to read that evaluation again. Only a qualified adapter can recover an
interrupted exclusive calculation. A historical quote retains its sealed terms.

For `destination_contact_incomplete` at `/destination/contact`, collect the
recipient name and phone, then issue a new destination snapshot. This applies to
physical delivery even when shipping is free. If the destination has expired,
issue a fresh snapshot and use a new quote key. If verified payment limits
exclude the payable, choose a supported amount within the returned range and
request a fresh quote.

## Install and inspect payment limits

This experimental setting is available on native PostgreSQL after applying the
selected migration plan. Use opaque installation and merchant references.
Use 1–200 UTF-8 bytes for each opaque reference, including the profile.
The rail mode is `test` or `live` and the currency is three uppercase ASCII
letters. The seven rail coordinates total at most 1,007 UTF-8 bytes. Bounds
are safe integers in currency minor units with `0 ≤ minMinor ≤ maxMinor` and
`maxMinor ≥ 1`. A supplied revision is a positive 32-bit integer.
The default checkout needs no setup.

In `payment-rail.mjs`, define the rail and its starting terms.

```js
export const scope = {
  installationRef: "store-a", channelKey: "online", methodKey: "card",
  providerKey: "processor-a", accountRef: "merchant-a", mode: "test", currency: "EUR",
};
export const terms = { ...scope, schemaVersion: 2, profileRef: "standard",
  minMinor: 1, maxMinor: 10000, active: true };
```

Run the installer from your server-side owner task using the migration-owner
executor at READ COMMITTED. Pass an inspected revision to update the terms.
Use the same tuple and profile. Rollback writes a new revision, either with
previous terms or with `active: false` to withdraw the rail.

```js
import { inspectCommerceMoneyLimitsV2, installCommerceMoneyLimitsV2 } from "@openlup/platform/commerce/server";
import { scope, terms } from "./payment-rail.mjs";

export const install = owner => installCommerceMoneyLimitsV2(owner, { value: terms, expectedRevision: null });
export async function rollback(owner) {
  const current = await inspectCommerceMoneyLimitsV2(owner, scope);
  if (!current.present) return current;
  return installCommerceMoneyLimitsV2(owner, {
    value: { ...current.value, active: false }, expectedRevision: current.revision,
  });
}
```

For connected show, export the owner reader from your app's `settings.mjs`.
Use the migration-owner URL for this operator command and a trusted app scope.
Return `{ present: false, effective: null }` for absence and a canonical decimal
string in `revision` for a present row.

```js
import { inspectCommerceMoneyLimitsV2 } from "@openlup/platform/commerce/server";
import { scope } from "./payment-rail.mjs";

export function createSettingsBindings({ db }) {
  return { readers: { "commerce.money_limits.v2.owner": async () => {
    const current = await inspectCommerceMoneyLimitsV2(db, scope);
    return current.present
      ? { present: true, value: current.value, revision: String(current.revision) }
      : { present: false, effective: null };
  } } };
}
```

```sh
./node_modules/.bin/openlup settings show commerce.money_limits.v2 --app ./settings.mjs \
  --database-url "$database_url" --json
```

Connected show reports the revision of inactive terms. A runtime reader returns
absence while the tuple is inactive. To reactivate, submit active terms with
the inactive revision as the expectation. On conflict, inspect the owner
revision and resubmit deliberately. If no tuple exists, retry the initial
insert. For an exhausted revision, have the installation owner qualify a
replacement rail. Sealed quotes keep their original terms.
