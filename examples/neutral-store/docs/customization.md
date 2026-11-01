# Customize the running store

Status: bounded development-preview application contract; real upgrade
preservation remains unproved. This is not a stabilized npm API.

## One input and three fragments

`owned/store.config.ts` exports the typed configuration. It contains brand
identity, theme tokens, localized copy, media paths, products and offer rules,
subscription cadences and market inputs. Both example configurations satisfy
`StoreConfig` in `shared/config.ts`. No theme framework, configuration service,
generated client or preview tool is involved.

The application owns `configurations`, `defaultConfigurationId` and
`selectConfiguration` in `owned/store.config.ts`. Add another typed configuration
there and select its ID as the default; no managed file needs a vertical name.
IDs are lowercase alphanumeric slugs with single hyphens, at most 80 characters.
The host and lifecycle use that owned default when `STORE_CONFIGURATION` is absent
or empty. Set the variable to select another registered ID. Unknown IDs refuse.
The registry and default are owned upgrade inputs; the slug validator and shared
offer rules remain managed. This bounded preview contract promises no wider API
stability or automatic upgrade preservation.


`owned/fragments.ts` contains three ordinary functions:

| Function | Intended presentation replacement |
| --- | --- |
| `offerIntro` | The offer introduction and its call to action |
| `productCard` | One card or row in the product listing |
| `checkoutSummary` | The estimated-money summary beside the form |

Each returns a DOM element and receives the same page context. Keep these
functions presentation-only: a hidden button does not change server authority,
and altered price text does not change the engine's quote. The small DOM helpers
use text nodes rather than interpreting configuration as HTML.

## Change identity, layout and one commercial rule

In one configuration, change `brand.name` and its localized strapline; set
`offer.layout` to `list` or `cards`; and change `offer.minUnits`, for example from
one unit to three. Restart the host after a configuration edit, rebuild after a
fragment edit, then open the running app.

The builder and checkout host both call `evaluateOffer` from `shared/offer.ts`.
A two-unit box with the example minimum of three must be refused by both. Do
not put the minimum separately in a click handler or server binding. The host
revalidates SKU, quantity, mode, cadence and terms before calling a checkout
binding. Package engines remain responsible for durable order, reservation,
payment and subscription truth. UI estimates never settle money.

Change product media by adding an owned SVG or image below `public/media/` and
updating the typed configuration. Add that file to the ownership inventory.
Product media paths must remain local; remote tracking images are not part of
this demo. Theme tokens are six-digit hex colors, and system fonts are used.

## Changes that need a page copy

Take ownership of a page when changing its complete structure, replacing the
checkout information architecture, adding a new account workflow, redesigning
operator navigation or introducing an application-specific route. A fragment
does not cover those changes. Copy only the affected managed page into an owned
path, change its import in the application, and move the relevant paths to the
owned side of `ownership.json`. You then own its security, accessibility,
compatibility, tests and manual porting of future fixes.

For a **new** `/about` route there is no existing page to copy:

1. Create `owned/about.ts` exporting a page function that accepts `PageContext`.
2. Take ownership of `client/main.ts` and `shared/routes.ts`: move those exact
   paths from `managed` to `owned` in `ownership.json`, and add `owned/about.ts`.
3. Add localized paths (for example `/about` and `/o-nas`) to the route map;
   import the page in the shell, add its dispatch case and navigation link.
4. Extend the route and browser tests for both paths. The host already serves
   extensionless application paths. This is an owned routing change, with manual
   porting of future shell/router fixes; it is different from copying an existing page.

New business rules that fit the existing offer input belong there. A rule that
needs a new shared application input can extend the application type and its
single validator. A missing generic package seam is reported to its owner; do
not edit an installed engine, copy its algorithms or split validation across
browser and server. New commercial behavior outside the accepted programme
requires its own authority.

## Preservation proof

Before upgrading, hash the owned files, add a fictional identity/layout/minimum
change, and commit that independent application's work. Use the installed
`openlup upgrade plan` and `openlup upgrade apply` once available. Compare owned
hashes, restart and repeat the minimum-unit refusal and successful purchase.
Record the actual old/new package and schema identities and browser results.
An unchanged file-copy test alone is not upgrade acceptance.
