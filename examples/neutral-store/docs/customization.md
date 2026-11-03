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
The host and lifecycle use that owned default when `--configuration` is absent.
Pass `--configuration <id>` to select another registered ID. Unknown IDs refuse.
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

## Support contact

Set optional `supportEmail: 'help@example.test'` in the owned configuration.
The shared validator beside `assertConfig` accepts a bounded ASCII email address
and refuses whitespace, HTML, URL schemes and other invalid values with
`starter_support_email_invalid`. Omit the field to show that no support contact
is configured. Both localized support pages render it as plain text, with no
HTML interpretation or generated email link, and link to the account page.
Restart after editing configuration. This field is an owned upgrade input.

## Public origin

`publicOrigin?: string` and `allowInsecurePublicOrigin?: boolean` are optional
fields of the owned `StoreConfig` in `owned/store.config.ts`. Existing registries
need no new export or field. Owned upgrade preservation includes these inputs.
For a host behind your own TLS terminator, set, for example,
`publicOrigin: 'https://store.example.test'`. The terminator must preserve the
original Host; X-Forwarded-Host, X-Forwarded-Proto, Forwarded and similar headers
are never authority. Validate the selected config before Docker work and again
at host startup; restart after an edit. No network publication changes follow.

Supply canonical lowercase ASCII (or already encoded punycode) host input, at
most 256 characters. A root slash and an explicit default port normalize to the
stored URL origin. Other parser repairs, uppercase/Unicode host input, trailing
dots, userinfo, whitespace, wildcard, path, query, fragment and non-HTTP(S)
schemes refuse. A non-loopback HTTP origin needs the explicit
`allowInsecurePublicOrigin: true` opt-in; use HTTPS for a TLS terminator.
The HTTP loopback exemptions are exactly `localhost`, `127.0.0.1` and `[::1]`;
no DNS lookup establishes an exemption. Exact IP literals and loopback origins
on a different port are permitted:
the operator still selects one complete origin, including the externally mapped
port. This does not supply a browser-trusted certificate or validate DNS/TLS
ownership. Host matching stays exact, including IPv6 brackets and nondefault
ports. For default ports browsers send no port in Host. Writes must send the
canonical origin exactly, without a slash or explicit default port.

The validator names `starter_public_origin_invalid`,
`starter_public_origin_not_canonical`, `starter_public_origin_flag_invalid` and
`starter_public_origin_tls_required`. HTTP admission retains
`starter_local_host_required` and `starter_same_origin_required`.
The latter covers missing/null/mismatched Origin, duplicate/multi-valued Origin,
missing request marker and a non-JSON write. Every non-GET/HEAD method receives
the check, including routes outside `/api/actions`.

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

## Demonstration sessions and mailbox

Sessions live in a single process, expire after one hour, have capacity 1000 and
are lost on restart. This is not a production session store. Customer ownership
and operator membership are rechecked by the native stores on requests.
The demonstration mailbox is not a real mailbox. Its captured messages are
written to a 0600 file by the container's `node` user under `/application`.
From the extracted application directory, read it with:

```sh
docker compose exec -T --user node application cat /application/.context/captured-messages/identity.jsonl
```

Filesystem access to this demonstration mailbox exposes sign-in tokens. Keep it
private; the host does not publish it through HTTP.

## Catalogue authoring and storefront

Live products, SKUs, price lists, price entries and promotions are seed data: one owned demo-seed step with the install connection, no runtime writer for them and no checkout promotion codes. Bundle drafts, compositions, target prices and activation, and catalogue drafts, are administered by a native human operator through their native writers.

`owned/catalogue.ts` installs the fictional `starter:item@1` authoring type for
both configurations; replace its content validator and type definitions in your
application. Draft payloads cannot install executable validators. The operator
page accepts create/revise/abandon and detail/list requests. The host supplies the
command key and session actor; neither comes from the JSON editor.

Catalogue drafts write only isolated authoring tables (packages/platform/sql/20260908100000_catalog_draft_foundation.sql:1-9); bundle activation sets the native bundle status to active (packages/platform/sql/20260812210000_bundle_operator_write_boundary.sql:493), while this application’s storefront and checkout still use typed configuration through evaluateOffer (examples/neutral-store/shared/offer.ts:40), so neither creates a new purchasable storefront offer.

See the [operator roster recipe](../README.md#operator-support-roster-and-catalogue-authoring) for support provisioning and deactivation through the owner connection.
