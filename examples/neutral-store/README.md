# Neutral store

Status: local application draft. Base-candidate compilation and browser
navigation are checked; full installation, sandbox purchase and upgrade
qualification remain pending. This is not a stable or supported framework.

This is an application, not an npm package or a monorepo workspace. It uses the
three OpenLup packages through public entries, ordinary TypeScript, a small
browser UI, system fonts and application-owned configuration. The fictional
supplement and coffee catalogues use the same pages, validation and host seams.

## Current candidate

The installer catalogue and purchase/account stores are being delivered by
their package owners. Until they land, the app deliberately returns
`host_binding_required` at dependent actions. The catalogue and UI can be
inspected without pretending an order was persisted. `./lifecycle up` currently
refuses `starter_installation_binding_required`; it does not declare a partial
installation ready. Final release pins and lockfile wait for the selected set.

An accepted native limit and a missing required purchase binding are different:
the former is documented acceptance, the latter still blocks completion.
See [limits](docs/limits.md) and [proof](docs/proof.md).

## Start from an exact source archive

The release route is a source archive, followed by the small extraction script.
No generator package or author checkout is required. Select the exact public
release and its source commit; do not use a floating main archive. The final
release reference is pending; the following shows the shape, not a published
artifact claim:

```sh
# Download the source archive for your selected immutable release commit.
# Extract it into a staging directory using your normal archive tool.
node /path/to/extracted-release/examples/neutral-store/extract.mjs /path/to/empty-store
cd /path/to/empty-store
```

The script requires Node 24 and Git. It refuses a nonempty destination, copies
only application-owned and managed inventory entries (not source-only extraction
tooling or its tests), creates a new `.git` directory and
materializes the application agent guide. It never searches a parent directory,
copies the monorepo configuration or resolves workspace packages.

During candidate development, supply only the three selected tarballs as
described in [candidate artifacts](artifacts/README.md). The application manifest
contains exact `file:` references to those bytes. Candidate import records their
names, equal set version and SHA-256 identities. It does not certify publication.

## Run the local application

Target prerequisites for the final cold path are Docker with Compose and an
exact release archive. The target command is:

```sh
./lifecycle up
```

That path is **not qualified in this draft**: the selected installer and native
bootstrap are still absent. It must eventually install the selected npm set,
apply its catalogue and seed fictional data automatically, serve the app at
`http://127.0.0.1:4319` and support a sandbox order, without keys, source edits or
manual migration. A page-only health check does not establish that outcome.

For authorized UI development after importing the candidate and generating its
lockfile, use the application directory and its own toolchain:

```sh
npm ci
npm run build
npm start
```

The running app is the customization preview. It displays local-candidate and
sandbox notices. The host binds to loopback; the container publishes its port
only on loopback. Do not expose this local demonstration to a public network.
No external email provider, payment provider or marketplace connector is active.

To run the other configuration through the same code:

```sh
npm start -- --configuration coffee
```

Stop the running process before restarting on the same port. For the eventual
Compose path, use `./lifecycle up --configuration coffee`. With no flags,
`./lifecycle up` uses the owned default.
`./lifecycle down` stops this Compose project without deleting persistent data.

## Customize and upgrade

Read [customization](docs/customization.md), [ownership](docs/ownership.md) and
the generated application agent guide. The typed input lives in
`owned/store.config.ts`; localized general copy lives in `owned/copy.ts`; three
named UI fragments live in `owned/fragments.ts`.

A selection below the configured purchase minimum remains saved across browser
reloads and storage updates. The shared validator still refuses checkout until
that minimum is met; a saved partial selection is not an eligible order quote.

`./lifecycle verify` and `./lifecycle upgrade` delegate to the installed public
CLI when it exists. They refuse explicitly before that capability is shipped.
They do not replace it with an application-owned upgrade engine. A real
`openlup upgrade apply` preservation witness remains required.

## Install-only fictional catalogue

`./lifecycle up` calls `installation/install.ts` before starting the host. Once
an installed bootstrap is bound, it obtains a dedicated install connection and
applies **one** owned `owned/demo-seed.ts` step. The pure builder reads the same
`StoreConfig` as the UI: deterministic product/SKU/list/price identifiers and
parameterized upserts populate only `catalog_products`, `catalog_skus`,
`price_lists` and `price_entries`. Repeating installation updates the same rows.
There is no runtime catalogue/price writer on this portable rail (N1).

The bootstrap must mark a newly created demonstration database with database
comment `openlup-neutral-store-demo-v1`. The applier reads that marker from
PostgreSQL, checks both login and current role against the dedicated install
identity, refuses either runtime identity and closes the connection after its
transaction. It never marks an arbitrary existing database as a demo.
`starter_installation_binding_required`, `starter_seed_runtime_role_forbidden`,
`starter_seed_install_role_required` and
`starter_seed_demonstration_database_required` name the refusal boundaries.
The current base candidate has no bootstrap, so `up` still refuses before any
connection, Docker invocation or seed write. No environment variable enables it.

Clients, stock and settings use native writers; they are never seeded here.
Subscription renewal terms, term lines and method states belong to the native
purchase path and must never be hand-written by this application. After the
catalogue seed, purchase uses zero hand-written business rows. This data step
is not a schema installer, price editor, promotion engine or customer import.

## Data boundary

All identities, contacts, catalogue entries, labels and prices are fictional.
The supplement catalogue contains no health claim or consumption advice. No
money is charged, real parcel sent or real invoice issued. Use `.test` addresses
and fictional contacts only. The browser cart is convenience state, not an order.

Do not point this demo database or its identities at customer infrastructure.
A customer environment needs its own authority, restricted runtime and migration
identities, terms, tax and shipping policy, operational controls and verified
provider bindings. Changing an environment variable does not establish those.

## Pages and proof

The footer's message-links page lists every message destination in both locales.
Sample grant links deliberately use invalid values, which must refuse instead of
accessing another account. Local captured messages must supply real scoped
grants once their bindings exist. Follow [destination mapping](docs/destinations.md)
for the mounted paths and [proof](docs/proof.md) for required execution evidence.

## Neutral inputs and local transport

Both fictional catalogues use the ISO test currency `XTS`, fictional country
`ZZ` and timezone `UTC`. Amounts are illustrative test units, with no exchange,
pricing, tax or jurisdiction claim. Polish and English remain UI content; money
formatting uses the selected locale ID directly.

The starter reads no environment configuration. For direct host use, pass
`--configuration <id>`, `--port <number>` and `--listen <address>` after `npm start --`.
The port defaults to 4319 and listen address to 127.0.0.1. The only other supported
listen address is 0.0.0.0 for explicit container transport. Unknown/duplicate flags,
missing values, invalid ports/addresses and unknown configurations refuse by name.
Compose passes the container listen/port flags and publishes only host loopback.
Lifecycle accepts the optional configuration flag for `up`; the same selected ID
reaches the install step and child host through a stdin Compose command override.
The documented no-flag `./lifecycle up` remains the one-command target.

These arguments contain only a public configuration ID, port and listen address.
There are no credential arguments, URLs, keys or passwords. The current installer
capability and runtime login are unbound; no password or socket capability is
silently manufactured. A later bootstrap needs its own qualified capability and
security review. This preview still refuses before installation when that binding
is absent. No customer environment is selected by a demonstration flag.
