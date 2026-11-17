# Customize the running store

Status: maintainer implementation notes. Reader guidance: [OpenLup guide](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/customize-the-starter.md). Sections marked "Evidence" are frozen historical records.

`dev.mjs` owns the source build/watch and host restart loop.

## One input and three fragments

`owned/store.config.ts` exports `configurations`, `defaultConfigurationId` and
`selectConfiguration`; each configuration satisfies `StoreConfig` in
`shared/config.ts`. The host and lifecycle share that registry. The managed
`assertConfig` validator admits lowercase alphanumeric IDs with single hyphens,
at most 80 characters, and checks required document, return and hold settings.

`owned/fragments.ts` exports `fragments` with `offerIntro`, `productCard` and
`checkoutSummary` methods and their `CustomizationFragments` interface. Each
receives `PageContext` from `client/context.ts`; the product method also receives
its product and the summary receives its quote.

## Change identity, layout and one commercial rule

The builder and checkout host both call `evaluateOffer` from `shared/offer.ts`.
The example's minimum is three units; its two-unit refusal is shared by both.
Host admission revalidates SKU, quantity, purchase mode, cadence and terms.
`assertConfig` requires local product-media paths and six-digit hexadecimal theme
colors. The source watcher is `dev.mjs`; its host dependencies and client build
remain separate restart/build operations.

## Subscription editor values

For the current source candidate, `subscriptionOffers` in `owned/store.config.ts`
is the commercial input for checkout and classic/sized servicing. The typed
`shared/subscription-offer.ts` helper accepts `set(...)` and `range(min,max,step)`;
ranges use `(value-min)%step === 0`. Global cadence and explicit per-SKU rules
both apply. Missing SKU/rule refuses, and overlapping cadence rules or a default
outside its domain refuse configuration. List concrete variants explicitly;
adding a catalogue variant never grants it admission automatically.

`checkoutDays` and `preferredDays` optionally narrow acquisition and visible
choices within `days`. `defaultDays` only selects an initial value. Neither a
default nor a recommendation widens admission. Checkout can have its own
`checkoutMinimumBaseUnits`; servicing uses `minimumBaseUnits`. One-time purchases
retain the cart's independent purchase-mode and total-unit checks.

`owned/subscription-editing.ts` derives editor limits and choices from this input;
physical-size preferences, portion modes and synthetic subject/catalogue facts
remain there. Full-result classic, exact and sized preview/apply admission covers
unchanged lines and add-ons, including edits retaining frozen prices. Selecting a
cadence preserves quantities; incompatible selections must be repaired explicitly.
Current membership is checked only for fresh checkout/editor work. Completed
matching receipts replay before current membership; payload conflicts still refuse.
Existing active commitments are not rewritten by changing configuration.

Installation writes `subscription_minimum_base_units` as text in
`commerce_settings`; the package's TypeScript and SQL minimum checks read that
same value. Admission checks that installed minimum against the owned input;
reapply the existing demonstration installation and restart after changing it.
A stale installation refuses edits rather than silently using different minima.
It also writes the matching introductory phase policy and the
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

The `supportEmail` validator beside `assertConfig` admits bounded ASCII email
and refuses whitespace, HTML and URL schemes with `starter_support_email_invalid`.
`client/pages/destinations.ts` renders the optional owned value through text
nodes, without an email link or form, and links the localized account route.

## Public origin

`assertPublicOrigin` in `shared/config.ts` owns the optional `publicOrigin` and
`allowInsecurePublicOrigin` inputs. It caps input at 256 characters and normalizes
only a root slash or explicit default port. Its HTTP exemptions are exactly
`localhost`, `127.0.0.1` and `[::1]`, without DNS lookup.

`createOriginPolicy` and `admitRequest` in `host/origin-policy.ts` own exact Host
selection and Origin/request-marker/content-type admission. The configuration
validator uses `starter_public_origin_invalid`, `starter_public_origin_not_canonical`,
`starter_public_origin_flag_invalid` and `starter_public_origin_tls_required`;
HTTP admission uses `starter_local_host_required` and `starter_same_origin_required`.
Lifecycle validates configuration before Docker work; the host validates at startup.

## Preservation proof

The lifecycle wrapper delegates `openlup upgrade plan` and `openlup upgrade apply`
to the installed CLI.

Evidence (historical record, 2026-11-13):
Before upgrading, hash the owned files, add a fictional identity/layout/minimum
change, and commit that independent application's work. Use the installed
`openlup upgrade plan` and `openlup upgrade apply` once available. Compare owned
hashes, restart and repeat the minimum-unit refusal and successful purchase.
Record the actual old/new package and schema identities and browser results.
An unchanged file-copy test alone is not upgrade acceptance.

## Demonstration sessions and mailbox

`host/sessions.ts` owns the process-local session store: one-hour expiry,
capacity 1000 and no restart persistence. Native stores recheck customer ownership
and operator membership on requests.

`host/native-composition.ts` captures messages in the container's
`/application/.context/captured-messages/identity.jsonl`, mode 0600, owned by
`node`. The host never serves this file over HTTP. The quote-acceptance keyring
is separate private `.context` state admitted by the database demonstration
marker and preserved only across restarts of the same container.

## Catalogue authoring and storefront

`owned/catalogue.ts` supplies the `starter:item@1` registry to
`host/operator-composition.ts`. The native draft writer owns the command; the
host supplies the command key and session actor, outside the JSON payload.

Evidence (historical record, 2026-11-13):
Catalogue drafts write only isolated authoring tables (packages/platform/sql/20260908100000_catalog_draft_foundation.sql:1-9); bundle activation sets the native bundle status to active (packages/platform/sql/20260812210000_bundle_operator_write_boundary.sql:493), while this application’s storefront and checkout still use typed configuration through evaluateOffer (examples/neutral-store/shared/offer.ts:40), so neither creates a new purchasable storefront offer.

## Acquisition location choices

`owned/acquisition-addresses.ts` supplies choice IDs, localized labels and
opaque source/reference/revision/provenance tuples. The runtime maps the selected
ID to that tuple before calling the native acquisition case port.

The current starter explicitly refuses cadence configuration above 90 days
with `starter_database_cadence_limit`: historical SQL paths retain that bound.
The package DTO representation bounds are broader; SQL widening is deferred. Checkout admits at most 50 selected lines and
99 units per line within the configured total. Stock and seeded unit prices fit
PostgreSQL integers; each offered mode must have a positive seeded unit price.
Tax legal-basis text is at most 200 characters and the shared legal revision is
trimmed, nonempty text of at most 64 characters. Configuration rejects values
outside these native boundaries before composition.

Evidence (historical record, 2026-11-13):
The existing install-only seed uses the acquisition foundation migration header
contract (lines 16-17) to load the adopter-owned registry through the owner connection
behind the same identity and demonstration-marker checks as the catalogue.
Repeating an identical tuple is safe. A different provenance or inactive row
fails the entire transaction rather than overwriting it. A customer environment
needs its own owner-loaded registry and onboarding. Editing this list never
grants runtime registry writes or customer delivery qualification.
