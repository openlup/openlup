# Customize the starter store

Change the starter's identity, presentation and offer rules in your application.
Start with owned configuration and fragments; take ownership of a page when the
change reaches its structure or workflow.

## Edit and refresh

From the root of your extracted application, with dependencies prepared, run:

```sh
npm --prefix . run dev
```

The local edit loop runs on macOS and Linux. Edit configuration, fragments or
`client/style.css`, wait for a successful client build or host restart, then
refresh the browser manually. If the terminal reports an error, resolve it and
wait for the host to listen before refreshing. With `npm run build` and
`npm start`, restart the host after a configuration edit and rebuild the client
after a fragment edit. See the
[starter setup](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/neutral-store/README.md#local-ui-edit-loop)
for preparing the extracted application.

## Select your configuration

`owned/store.config.ts` exports `configurations`, `defaultConfigurationId` and
`selectConfiguration`. Add a configuration satisfying `StoreConfig` from
`shared/config.ts`, register it and choose its ID as the default. The host and
lifecycle use that default unless you pass `--configuration <id>`; an unknown ID
refuses with `starter_configuration_unknown`. IDs use lowercase letters and
digits separated by single hyphens, within the length bound checked by
`assertConfig`.

The configuration contains identity, localized copy, theme colors, media,
products, offer rules, subscription cadences and market inputs. Preserve these
required settings when adding a configuration:

| Setting | Required content |
| --- | --- |
| `documents.sandbox` | An `enabled` boolean and a nonempty `providerRef` |
| `returns.reasons` | Nonempty choices with unique codes and English and Polish labels |
| `orderControls.holdReasons` | Nonempty choices with unique native hold reason codes and English and Polish labels |

Invalid document, return or hold settings refuse with
`starter_order_controls_configuration_invalid`. A control being absent from a
page does not make its configuration optional.

## Change identity and an offer rule

Edit `brand.name`, its localized `brand.strapline`, `offer.layout` (`list` or
`cards`) and `offer.minUnits`. Refresh after the build or restart. Try a selection
below the new minimum: both the builder and host admission use `validateCart`
and refuse with `minimum_units`. Do not duplicate the minimum in a click handler.
The host also validates SKU, quantity, purchase mode, cadence and accepted terms;
a stale or unaccepted terms revision refuses with `starter_terms_required`.
Changing displayed amounts cannot change the authoritative package quote or
settle a payment.

Add product images below `public/media/`, update the product's `media` and
localized `mediaAlt`, and add the file to the owned inventory. Product media
must start with `/media/`; remote product images refuse with
`starter_product_invalid`. Theme colors use six-digit hex values; invalid tokens
refuse with `starter_theme_invalid`. The starter uses system fonts.

Keep configured cadence days and their default within the native whole-day
bounds. Cart validation also bounds selected lines, units per line and the
configured total. Stock and seeded per-mode prices must fit PostgreSQL integers,
and each offered mode needs a positive price. Keep tax legal-basis text and the
trimmed, nonempty legal revision within `assertConfig`'s limits. Configuration
validation runs before composition; do not rely on browser controls to enforce
these limits.

| Input | Boundary |
| --- | --- |
| Configuration ID | At most 80 characters |
| Cadence and default | Whole days from 1 through 120 |
| Cart | At most 50 lines and 99 units per line, within the configured total |
| Stock quantity | Integer from 0 through 2147483647 |
| Seeded per-mode unit price | Integer from 1 through 2147483647 |
| Tax legal-basis text | Trimmed length at most 200 characters |
| Legal revision | Trimmed, nonempty, at most 64 characters |

## Replace a presentation fragment

Edit the `fragments` object in `owned/fragments.ts`:

| Function | Presentation it replaces |
| --- | --- |
| `offerIntro` | Offer introduction and call to action |
| `productCard` | Product card or list row |
| `checkoutSummary` | Money summary beside the checkout form |

Each function receives `PageContext` and returns a DOM element; the card also
receives its product and the summary its quote. Keep fragments about
presentation. Hiding a button grants no authority. Use the DOM helpers' text
nodes for configuration and copy rather than interpreting them as HTML.

## Configure subscription editing

`owned/subscription-editing.ts` builds `StoreConfig.subscriptionEditing`. Change
classic minimum base units, plan choices and quantity or line bounds there.
Size-aware settings include the core minimum, allowed cadences, group and line
limits, preferred and nominal physical sizes, portion modes and factors, and
synthetic need and exclusion facts. The extra editor catalogue is installed for
servicing; it does not add a size-aware purchase flow to checkout.

Installation writes `subscription_minimum_base_units` as text in
`commerce_settings`, together with the introductory phase policy and synthetic
subject facts. The editor resolves those installed facts for the authenticated
customer and locks them when applying a change. An explicit `currentExclusions`
array takes precedence over inherited exclusions, even when empty. Do not
substitute browser-supplied facts. Demand-driven resizing refuses with
`starter_subscription_resize_unconfigured`; there is no need-entry form.

The demonstration supplies grouped variants, physical sizes, demand units,
exclusions, verified product documents and fictional stock through the native
stock writer. Replace the fictional data and fact resolvers for your own
application. Product labels and illustrative coverage are not usage advice.

## Set the support contact

Set optional `supportEmail` in the owned configuration, for example
`help@example.test`, then restart the host. Invalid input refuses with
`starter_support_email_invalid`; use a bounded ASCII email address without
whitespace, HTML or a URL scheme. Omit the field to show the unconfigured-contact
message. Both localized support pages display the value as plain text and link
to the account page; they add no email link or contact form.

## Set the public origin

For your TLS terminator, set `publicOrigin` to the external origin, such as
`https://store.example.test`. Preserve the original `Host` header. Forwarding
headers do not establish the admitted origin. Restart after an edit; setting
this field does not publish the application or provision DNS or a certificate.
The lifecycle validates configuration before starting containers and the host
validates it again on startup.

Use canonical lowercase ASCII or already encoded punycode, within the
256-character input limit. A root slash and an
explicit default port normalize to the URL origin. Userinfo, whitespace,
wildcards, trailing dots, paths, query strings, fragments, other schemes and
parser repairs such as uppercase or Unicode host input refuse. Host matching
is exact, including IPv6 brackets and nondefault ports. Choose the full external
origin, including a mapped port; writes send its canonical form without a slash
or explicit default port.

Non-loopback HTTP requires `allowInsecurePublicOrigin: true`; prefer HTTPS.
The HTTP exemptions are exactly `localhost`, `127.0.0.1` and `[::1]`, without a
DNS lookup. IP literals and loopback origins on another port can be selected.
Both optional fields belong to your owned configuration.

| Refusal | Check |
| --- | --- |
| `starter_public_origin_invalid` | Invalid URL shape or input length |
| `starter_public_origin_not_canonical` | Input requires an unaccepted parser repair |
| `starter_public_origin_flag_invalid` | Insecure-origin opt-in is not boolean |
| `starter_public_origin_tls_required` | Non-loopback HTTP lacks the opt-in |
| `starter_local_host_required` | Host is absent, ambiguous or outside the selected authority |
| `starter_same_origin_required` | Ambiguous Origin, or a write without the exact Origin, `X-Starter-Request: 1` and JSON content type |

All methods other than GET and HEAD receive write admission, including paths
outside the action API. Missing, null or mismatched Origin cannot authorize a
write. A duplicate or comma-separated Origin also refuses on reads.

## Change a page or add a route

For complete layouts, checkout structure, account workflows, operator navigation
or application-specific routes, follow
[starter page ownership](../../concepts/starter-ownership.md#take-ownership-of-a-page).
Copy only the affected page, update its imports and inventory, and maintain its
security, accessibility, compatibility and future fixes yourself.

For a new `/about` route, create `owned/about.ts` with a page function accepting
`PageContext`. Take ownership of `client/main.ts` and `shared/routes.ts`, moving
their exact paths from `managed` to `owned` in `ownership.json`, and register the
new file. Add localized paths such as `/about` and `/o-nas`, dispatch, navigation
and checks for both paths. The host serves extensionless application paths.

Put a rule that fits the offer input there. For a new shared application input,
extend the type and its validator together. Report a missing package extension
seam to its owner; keep installed engines and their algorithms in the packages.

## Check preservation when upgrading

Record hashes of owned files and commit your application's customization before
upgrading. Use the installed application's upgrade procedure, then compare the
owned files, restart, and repeat a below-minimum refusal and an admitted sandbox
purchase. Record package and schema identities and the observed browser result.
Unchanged copied bytes alone do not establish working behavior. See
[Upgrade application files](../../upgrade/application-files.md).

## Protect local sessions and messages

Sessions are held in process memory; restarting loses them. The session lifetime
is one hour and capacity is 1000 entries; a full store refuses with
`starter_session_capacity_exceeded`. Customer ownership and operator membership are rechecked against
native stores. Replace this session storage for a production application.

The demonstration captures sign-in messages privately rather than sending mail.
Read `identity.jsonl` as the container's `node` user using the
[local mailbox recipe](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/neutral-store/README.md#host-origin-and-local-sessions).
The file is created with mode `0600`. Access exposes sign-in tokens; keep it
private. HTTP serves only built assets, not the mailbox.

The separate quote-acceptance keyring is generated only for a marked
demonstration database. The same container reuses it on restart; recreation
requires fresh quotes. Supply your own private keyring with
`--quote-acceptance-key-file` outside served assets and browser configuration
when composing your own environment.

## Separate catalogue drafts from offers

The installer seeds live products, SKUs, price lists, prices and promotions.
The starter has no runtime writer for those seed inputs, and checkout promotion
codes refuse with `starter_promotion_codes_unsupported`. A human operator can
administer catalogue drafts and bundle composition, target prices and activation
through native writers. Neither draft authoring nor bundle activation adds a
product to the starter's configured storefront or checkout selection.

Replace the fictional `starter:item@1` registry and content validator in
`owned/catalogue.ts` for your application. Draft payloads cannot install
executable validators. The operator can create, revise, abandon, list and read
drafts; the host supplies the actor and command key. Provision and deactivate
support access through the
[operator roster recipe](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/neutral-store/README.md#operator-support-roster-and-catalogue-authoring).

## Replace acquisition location choices

`owned/acquisition-addresses.ts` contains fictional choice IDs, localized labels
and opaque source, reference, revision and provenance tuples. Keep IDs unique
and stable. The browser submits a choice ID, email and explicit consent; the
host selects the tuple and refuses extra fields. Applicant names are not
collected. Submission persists through the native acquisition port.

Load your own registry and onboarding through the database owner connection.
The demonstration installer admits only its install identity and marked
database. An identical tuple can be installed again; changed provenance or an
inactive row refuses with `starter_acquisition_seed_conflict` and rolls back
the transaction. Editing the list grants no runtime registry writer or delivery
qualification.
