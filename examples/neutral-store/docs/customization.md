# Customize the running store
Moved to [Customize the starter store](../../../packages/core/docs/guide/how-to/build/customize-the-starter.md#edit-and-refresh).

Status: moved to the [OpenLup guide](../../../packages/core/docs/guide/how-to/build/customize-the-starter.md); this page keeps its headings so links resolve. Sections marked "Evidence" are frozen historical records.

`dev.mjs` owns the source build/watch and host restart loop.

## One input and three fragments
Moved to [Customize the starter store](../../../packages/core/docs/guide/how-to/build/customize-the-starter.md#select-your-configuration).

`shared/config.ts` owns starter configuration validation; `owned/fragments.ts` is the presentation implementation.

## Change identity, layout and one commercial rule
Moved to [Customize the starter store](../../../packages/core/docs/guide/how-to/build/customize-the-starter.md#change-identity-and-an-offer-rule).

`shared/offer.ts` owns shared cart admission; `host/quote-composition.ts` composes installed money authority.

## Subscription editor values
Moved to [Customize the starter store](../../../packages/core/docs/guide/how-to/build/customize-the-starter.md#configure-subscription-editing).

`host/editor-ports.ts` owns the synthetic subject resolver and apply-time row lock.

Evidence (historical record, 2026-11-13):
Subscription editing values live in `StoreConfig.subscriptionEditing`, built by
`owned/subscription-editing.ts`. Set classic minimum base units, plan choices and
quantity/line bounds there. Size-aware values include core minimum, cadence set,
group/line limits, preferred and nominal physical sizes, portion modes/factors,
and the synthetic need/exclusion fixture. The extra catalogue is install-only;
it does not add a size-aware acquisition flow to checkout.

Installation writes `subscription_minimum_base_units` as text in
`commerce_settings`; the package's TypeScript and SQL minimum checks read that
same value. It also writes the matching introductory phase policy and the
synthetic subject fixture. Each owned demonstration customer uses that fixture
with its own authenticated subject reference. Explicit current exclusions take
precedence over inherited exclusions, including an empty array. The host locks
the installed fixture row during apply; do not replace it with browser facts.
There is no need-entry form or demand-driven plan/portion resize policy.

The configuration supplies grouped variants, exact physical size, synthetic
demand units, exclusion attributes and fictional stock quantities. The install
creates verified opaque documents and uses the public stock writer. A real
application must replace these fictional data and resolvers with its own owned
facts. Neither a product label nor illustrative coverage is usage advice.

## Support contact
Moved to [Customize the starter store](../../../packages/core/docs/guide/how-to/build/customize-the-starter.md#set-the-support-contact).

`client/pages/destinations.ts` owns managed support rendering.

## Public origin
Moved to [Customize the starter store](../../../packages/core/docs/guide/how-to/build/customize-the-starter.md#set-the-public-origin).

`host/origin-policy.ts` owns request admission; `shared/config.ts` owns origin parsing.

## Changes that need a page copy
Moved to [Customize the starter store](../../../packages/core/docs/guide/how-to/build/customize-the-starter.md#change-a-page-or-add-a-route).

The reference host serves extensionless paths through the built shell; shell dispatch remains in `client/main.ts`.

## Preservation proof
Moved to [Customize the starter store](../../../packages/core/docs/guide/how-to/build/customize-the-starter.md#check-preservation-when-upgrading).

The preservation recipe below records the earlier qualification procedure, not an executed upgrade result.

Evidence (historical record, 2026-11-13):
Before upgrading, hash the owned files, add a fictional identity/layout/minimum
change, and commit that independent application's work. Use the installed
`openlup upgrade plan` and `openlup upgrade apply` once available. Compare owned
hashes, restart and repeat the minimum-unit refusal and successful purchase.
Record the actual old/new package and schema identities and browser results.
An unchanged file-copy test alone is not upgrade acceptance.

## Demonstration sessions and mailbox
Moved to [Customize the starter store](../../../packages/core/docs/guide/how-to/build/customize-the-starter.md#protect-local-sessions-and-messages).

`host/sessions.ts`, `host/native-composition.ts` and `installation/install.ts` own the reference session, capture and demonstration-key composition.

## Catalogue authoring and storefront
Moved to [Customize the starter store](../../../packages/core/docs/guide/how-to/build/customize-the-starter.md#separate-catalogue-drafts-from-offers).

`host/operator-composition.ts` binds native authoring; storefront selection remains in the shared offer validator.

Evidence (historical record, 2026-11-13):
Catalogue drafts write only isolated authoring tables (packages/platform/sql/20260908100000_catalog_draft_foundation.sql:1-9); bundle activation sets the native bundle status to active (packages/platform/sql/20260812210000_bundle_operator_write_boundary.sql:493), while this application’s storefront and checkout still use typed configuration through evaluateOffer (examples/neutral-store/shared/offer.ts:40), so neither creates a new purchasable storefront offer.

## Acquisition location choices
Moved to [Customize the starter store](../../../packages/core/docs/guide/how-to/build/customize-the-starter.md#replace-acquisition-location-choices).

`installation/install.ts` owns the demonstration registry load transaction.

Evidence (historical record, 2026-11-13):
The existing install-only seed uses the acquisition foundation migration header
contract (lines 16-17) to load the adopter-owned registry through the owner connection
behind the same identity and demonstration-marker checks as the catalogue.
Repeating an identical tuple is safe. A different provenance or inactive row
fails the entire transaction rather than overwriting it. A customer environment
needs its own owner-loaded registry and onboarding. Editing this list never
grants runtime registry writes or customer delivery qualification.
