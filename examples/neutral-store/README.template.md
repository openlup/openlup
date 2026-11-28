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
The runtime credential file must stay in owner-only configuration. The starter
validates it at start. The project in `.context/compose-project` is assigned
to this directory until `./lifecycle down` stops it and clears the record.
See “Run a bounded background pass” in the installed starter guide for the
project-qualified maintenance commands.

To use another free local port, export `OPENLUP_STARTER_PORT=4320` in the shell
that runs `./lifecycle up` and `npm run catalogue:apply`. Use a decimal port
from 1024 to 65535. With the default origin, exclude [ports blocked by Fetch](https://fetch.spec.whatwg.org/#port-blocking).
An unset or empty value uses 4319. A Compose-only `.env`
value does not configure either lifecycle command. Use a separate application
directory, `COMPOSE_PROJECT_NAME`, and port for each concurrent demo.
A configured `publicOrigin` still governs request authority.

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

## Qualify a provider test account

The qualification command requires a candidate extraction with the optional
provider profile, Node 24.21.0, npm 11.19.0, and the 1Password CLI (`op` on your
PATH). If you already have that extraction, open its directory and run `npm ci`.
To create one, install the source checkout's dependencies with `npm ci`, then
run the following commands from the root of the clean candidate checkout.

```sh
candidate_dir="$(mktemp -d "${TMPDIR:-/tmp}/provider-qualify-XXXXXX")"
revision="$(git rev-parse HEAD)"
version="$(node -p "require('./packages/core/package.json').version")"
npm --prefix . run packages:check -- --out "$candidate_dir/packs" --release-set "$version"
manifest="$candidate_dir/packs/packages-manifest.json"

node --experimental-strip-types --input-type=module --eval "$(cat <<'NODE'
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCurrentPackManifest } from './scripts/packages/pack-manifest-input.ts';

const [candidate, revision, manifest] = process.argv.slice(1);
const packs = readCurrentPackManifest(process.cwd(), manifest, revision);
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const { providerQualification, ...app } = read('examples/neutral-store/package.json');
Object.assign(app.dependencies, providerQualification.dependencies);
const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
for (const section of sections) {
  for (const name of Object.keys(app[section] ?? {})) {
    if (packs.has(name)) app[section][name] = 'file:' + packs.get(name).path;
  }
}
const input = join(candidate, 'input');
mkdirSync(input);
writeFileSync(join(input, 'package.json'), JSON.stringify(app));
execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--fund=false'],
  { cwd: input, stdio: 'inherit' });
const path = join(input, 'package-lock.json'), lock = read(path);
for (const section of sections) {
  for (const name of Object.keys(lock.packages[''][section] ?? {})) {
    if (packs.has(name)) lock.packages[''][section][name] = packs.get(name).version;
  }
}
for (const [name, pack] of packs) lock.packages['node_modules/' + name].resolved = 'file:' + pack.path;
writeFileSync(path, JSON.stringify(lock, null, 2) + '\n');
NODE
)" "$candidate_dir" "$revision" "$manifest"

node examples/neutral-store/extract.mjs "$candidate_dir/application" \
  --mode candidate --set-version "$version" --source-revision "$revision" \
  --manifest "$manifest" --lockfile "$candidate_dir/input/package-lock.json" \
  --provider-qualification enabled
cd "$candidate_dir/application"
npm ci
```

Keep the candidate's `packs` directory available for `npm ci`. The generated
opt-in lock is at `$candidate_dir/input/package-lock.json`.

In an interactive terminal, configure the named variable with a private
1Password reference for the test account's secret key. Set `ACCOUNT_ID` to
the expected test account ID and `KEY_ENV` to the variable's name.

```sh
npm run provider:qualify -- --run --test-mode --account "$ACCOUNT_ID" --key-env "$KEY_ENV"
```

Open the local link when prompted and complete the provider challenge within
five minutes. This command qualifies card behavior using synthetic test objects
and writes a transcript with hashed identifiers. Tax qualification runs in a
separate step after the card qualification. The transcript records `tax: not_run`.
If a write has an unknown outcome, use the original operation in the bound test
account to reconcile it. Run the command again only for a new qualification.

## Change a product rule

If you upgraded an existing store, its draft validator still runs from
`owned/catalogue.ts`. To try installed rules, copy `owned/catalogue-rules.cjs`
and its test from a fresh extraction of your target starter version. Port your
existing content checks into the bundle's `validateContent` so your store keeps
its draft rules after switching.

Edit `owned/catalogue-rules.cjs` and update the examples in
`owned/catalogue-rules.test.cjs`.
After each change, run `npm run typecheck` from the extracted application root.
Run the rule test from the same directory:

```sh
node --test owned/catalogue-rules.test.cjs
```

The test runs the same hooks as installation. Keep the rules pure and use the
supplied arguments for time, locale and time zone. Include dependencies in the
build so the rules need neither `require` nor Node APIs.

`./lifecycle up` is the one install command for the updated rules.
`npm run dev` stays database-free. In **Catalogue drafts**, choose **Load draft example**, save it, then use **Prepare saved draft**
with the saved draft ID and revision. Fix a refusal at the field named in its
path and save again. The preparation report can wait for publication evidence.
The starter keeps earlier builds available for drafts already saved.

The owned market registry in `owned/market.config.ts` selects `locales` and
`defaultLocale`; supply copy for every configured locale.

`owned/store.config.ts` composes domain inputs including `owned/renewal.config.ts`
(account actions, pause presets, cancellation offers and retry timing) and `owned/quote.config.ts`. Follow the
installed starter guide's business-configuration convention when editing them.

`AGENTS.md` holds the instructions for coding agents working in this
application.

## Discover and check settings

After installing dependencies, search platform and starter settings by goal with
`npm --silent run settings -- list --goal "<goal>"` (for example,
`"renewal stock protection horizon"` or `"flat shipping"`). After editing owned
configuration, validate it offline with
`npm --silent run settings -- check --configuration <id>`. To expose the same
read-only discovery, check and preview operations to an MCP client, run
`npm --silent run settings -- mcp`. See
`node_modules/@openlup/core/docs/guide/how-to/operate/configure-settings.md`.

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
