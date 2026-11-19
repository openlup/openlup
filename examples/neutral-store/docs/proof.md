# Verify the starter

Status: current starter verification recipe for stable 1.x. Run from the independent application
root with its exact selected artifacts, Node 24, npm 11.19.0 and Docker with
Compose. Install the selected package set using the application's README first;
for a candidate import, `./lifecycle candidate` must finish before `npm ci`.

```sh
npm ci
npm test
npm run typecheck
npm run build
./lifecycle browser
```

Record the package versions, artifact identities, configuration and actual
command exits. Use the application's installation and verification authority;
this recipe supplies no release or deployment authority.

## Extraction identity

Follow the source README's
[extraction input contract](https://github.com/openlup/openlup/blob/main/examples/neutral-store/README.md#extraction-input-contract)
for released, reconstructed and candidate modes. Keep `.starter-origin.json`
and the selected lockfile. Extraction does not install dependencies or establish
purchase behavior; a reconstructed starter retains its explicit reason.

## Focused checks

Pure tests, typecheck and build check local rules and application composition.
They do not establish durable purchase, upgrade survival or provider delivery.
The default `npm run test:browser` preview cannot qualify a database purchase.
Use the database-backed gate below for that boundary. Never change a required
purchase result to `host_binding_required` to pass a database-less run.

## Database-backed purchase acceptance recipe

`./lifecycle browser` creates fresh PostgreSQL installations and restricted hosts
for both configurations. It runs the selected database browser groups, including
purchase, subscription activation, renewal and recovery, and removes its hosts
and containers. To select affected specs with that same setup, use, for example:

```sh
./lifecycle browser browser/acquisition.spec.ts
```

The generated `.context/database-ui-hosts.json` contains loopback UI origins.
The separate mode-0600 `.context/care-browser/fixtures.json` contains private care
material, matching each project and origin to runtime/owner connections and its
mailbox. Keep it private and outside served assets and public reports. Traces,
screenshots and video stay off. Run configurations with their actual selected
database bindings; UI navigation or a captured sandbox receipt does not qualify
a live provider. See [application setup](../README.md) and the installed guide
at `node_modules/@openlup/core/docs/guide/reference/limits.md`.

## Subscription editor proof

With the selected packages installed and built, run the component recipe:

```sh
npx --no -- playwright test --config playwright.editors.config.ts
```

Synthetic component responses prove UI behavior only. Durable classic, sized and
API editor journeys use the database gate and its
`browser/subscription-journeys.spec.ts` and `browser/subscription-api.spec.ts`
specs. Keep the installed package's refusal and replay behavior in those journeys.

## Frozen execution evidence

The [complete earlier proof record](https://github.com/openlup/openlup/blob/main/docs/platform/history/neutral-store-proof-2026-11-13.md)
retains all dated runs and their original limits. Those results describe their
recorded artifacts and dates. Use the recipe above for a new candidate and
record new outcomes separately.
