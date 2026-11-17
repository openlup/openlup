# OpenLup starter application

This application was extracted from the OpenLup starter. It uses the
`@openlup/core`, `@openlup/outbox` and `@openlup/platform` packages through their
public entries, with application-owned configuration, browser pages and a local
host. Follow the installed guide’s stability and installation support policies;
this local demonstration alone does not qualify a production installation.

For a released extraction, `.starter-origin.json` records `mode: released`, the
exact set version and source revision. From this application's root, install its
committed registry lock and start the local database-backed demonstration:

```sh
npm ci
./lifecycle up
```

Use Node 24, npm 11.19.0 and Docker with Compose. The lifecycle installs the
packaged PostgreSQL history and fictional catalogue, then serves
`http://127.0.0.1:4319`. `./lifecycle down` stops the project while preserving data.
Keep this passwordless demonstration isolated; deployment needs your own
composition and authority. Both one-time and subscription purchases are included.

Read `node_modules/@openlup/core/docs/guide/README.md` after installation.
`how-to/build/customize-the-starter.md` explains the local demonstration, edit
loop, owned configuration and application-file upgrades. `docs/proof.md` gives the current verification recipe and links the extraction
modes and archived evidence. Reconstructed extraction retains its
explicit reason and does not claim original released-starter provenance.

After installing dependencies, build and
serve the database-free demonstration with the `build` and `start` package
scripts; on macOS and Linux the `dev` script runs the watched edit loop.
This database-free demonstration supplies one-time estimates; subscription prices
require the installed local demonstration. Its localized `host_binding_required` guidance
points to `./lifecycle up`. Installed quotes serve both purchase modes. Known
price refusals explain a repair using `owned/quote-copy.ts`; unknown failures
remain generic, and a failed refresh withholds the previous price.
After a successful candidate import prints `next: npm ci`, run `npm ci` before
starting the application.

`owned/store.config.ts` composes domain inputs including `owned/renewal.config.ts`
(cancellation offers and retry timing) and `owned/quote.config.ts`. Follow the
installed starter guide's business-configuration convention when editing them.

`AGENTS.md` holds the instructions for coding agents working in this
application.

## Contributor candidates

A candidate extraction retains local package-archive pins. Only for that mode,
set `CORE_ARCHIVE`, `OUTBOX_ARCHIVE` and `PLATFORM_ARCHIVE` to the full paths of
the selected candidate archives, then run:

```sh
./lifecycle candidate "$CORE_ARCHIVE" "$OUTBOX_ARCHIVE" "$PLATFORM_ARCHIVE"
npm ci
```

Import checks package names, equal versions and digests. It does not turn a
candidate into a released set. Never silently substitute candidate artifacts
for the selected release or rewrite a released lock to make installation pass.
