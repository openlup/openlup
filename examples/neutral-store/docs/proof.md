# Starter execution evidence

Status: historical record, 2026-11-13.

Recorded status: proof recipe with bounded base-candidate execution evidence below.

Run from the independent application's root with its exact selected artifacts.
Use the application's own installation, resource and verification authority.
The source recipe does not grant deployment or publication rights.

## Focused checks

```sh
npm test
npm run typecheck
npm run build
npm run test:browser
```

The pure tests discriminate shared offer rules, client price tampering,
authorization before a store call and missing checkout binding. The source
release additionally tests independent extraction and the materialized test layout. They do not establish durable purchase or upgrade behavior.

The browser recipe follows every message link in both locales, exercises a
browser cart across a reload, inspects a visible native refusal and requires a
successful sandbox purchase through the installed binding. The purchase test
must fail while that binding is absent. Do not skip it or change its expected
result to `host_binding_required`.

Run the browser recipe separately with each configuration selected. Record
which candidate artifacts, configuration and database were actually used.
Extend the engine journey with subscription activation, renewal and recovery
when the native path is available; a one-time purchase is insufficient evidence
for subscription acceptance.

## Subscription editor proof

The merged editor contribution has 68 passing focused source tests in seven touched
files: editor models, package-consumer compilation, frozen-order parcel notes,
session routes, installation, localized routes and extraction. Its separate
Playwright component recipe passes 21 cases for each configuration (42 total,
zero skips), using synthetic API responses. Those cases cover classic draft and
review interactions, stale quotes, size/count changes, catalogue refresh,
uncertain-save readback and explicit opt-in consent. They establish UI behavior,
not native purchase or durable editor acceptance.

With the selected package set installed and built, run from this directory:

```sh
node --experimental-strip-types --test test/subscription-models.test.ts test/editor-contracts.test.ts test/editor-mail.test.ts test/subscription-routes.test.ts test/installation.test.ts test/routes.test.ts test/extract.test.ts
npm run build
npx --no -- playwright test --config playwright.editors.config.ts
```

The final native recipes are `browser/subscription-journeys.spec.ts` (seven
classic and six sized journeys) and `browser/subscription-api.spec.ts` (four API
journeys). On 2026-11-06 the final run passed 17 cases per configuration, 34 total,
with zero failures, skips or retries in 50.8 seconds. The selected product stack
is `7731b97e26ba4e685b2a7a590d731433166c256f`, including the final sized editor
and settlement-ordering vocabulary correction. Later proof-only harness repairs
supply acquisition acceptance and the servicing preconditions described below.

The three local 0.36.0 development candidates use that stack's package inputs;
they are not published release pins. Their SHA-256 identities and packed sizes were:

| Artifact | SHA-256 | Packed bytes |
| --- | --- | ---: |
| `openlup-core.tgz` | `3818515857bf4b31c63d61bcb216d849b914af017cbfafbe0a342d8ed19f916d` | 183143 |
| `openlup-outbox.tgz` | `e723db165b4e55166180b2b962191e80e5bbc5735d851e9de20a2e93877f3af0` | 41203 |
| `openlup-platform.tgz` | `4c62b3c17a73dfe285e02844fedeede7e1b038a9029ab9231f63bda753ee36c4` | 2604082 |

Each configuration used its own disposable lifecycle installation: all 106
history units applied, repeat installation applied zero, and the HTTP host used
the non-superuser, non-BYPASSRLS `starter_runtime` login. Database ports were
unpublished; UI ports were loopback-only. The live shared-document reader matched
the selected source bytes in both hosts. Both readers use one current product
document with per-SKU variants; the separate editor document is gone.

The fixture obtains the native acquisition quote and acceptance before checkout,
then uses native sandbox settlement and customer challenge sign-in. Two native
introductory renewals prepare servicing cases for editing and opt-in; no marker,
paid-cycle counter, editable template, price list or renewal truth is backfilled.
The edit-window/payment-blocker case keeps its original purchase anchor so the
configured maximum 720-hour window can close it without moving the cycle.
This fixture correction resolved the initial 32/34 run; assertions and timing
bounds were retained. No product or SQL repair was needed.

Start separate disposable installed/seeded hosts for the two configurations.
Supply a private local keyring through `--quote-acceptance-key-file`, as described
in the [native quote composition](../README.md#native-quote-and-acquisition-composition);
the proof used a disposable keyring mounted read-only outside served assets.
The ignored `.context/database-ui-hosts.json` entries require `id`, loopback
`baseURL` and each proof-owned `composeProject`. Only the harness reads the private
captured mailbox. Test-owned rows may change to exercise drift, blocking and
exclusion repair. A missing native purchase template fails rather than falling
back to seeded editable lines. Run from this directory:

```sh
npx --no -- playwright test --config playwright.database.config.ts subscription-journeys.spec.ts subscription-api.spec.ts
```

The suite covers stale acceptance, payment/edit blockers, captured notice/no-op
behavior, retained pricing, stock/exclusion and withdrawal refusals, command
replay and named unconfigured-resize limits. Traces, screenshots and videos are
disabled. The notification journey uses a test-only native dispatcher with
captured delivery; it mounts no new serving consumer.

On the same stack, the installed checkout/quote file passed three cases: its two
existing single-SKU expectation sets unchanged and one added multi-size checkout
case. The latter quotes and buys the larger SKU of the same product, then proves
typed refusal when the selected SKU is absent from a current document with a
valid digest. The guest transfer file passed 2/2, including exact multi-variant
document round-trip and native sign-in/replay. Catalogue reads passed 52/52 with
unchanged expectations, UUID/HTTP checks 38/38 and recovery 8/8. The recovery run
retained native one-minute challenge cadences and took 381.79 seconds. The
paid-mail file's three final 9/9 runs are described below. Store compilation and
the repository consumer typecheck passed with zero errors against ceiling zero;
publication policy, structural rules, lint and neutrality checks passed.

Run one PostgreSQL-backed proof at a time after the one-minute load average is
at most 20. All proof-owned containers, volumes, image tags and host processes
were removed after this run, along with its disposable keyring. These are local
sandbox results, not hosted, provider, release or upgrade qualification.

## Selected catalogue fact comparison follow-up

On 2026-11-07 the corrected sized fact contract was integrated from `eee93280`
through merge `b00cc69f`. The host retains its owned subject/optional-need row
lock and rereads selected catalogue facts on the same apply connection. Preview
and recheck share one reader; UUID order and sorted exclusion keys match the
package evidence. Any mismatch refuses with
`subscription_edit_invalid_subject_snapshot`. Catalogue/product/SKU/document
rows are read without locks. Serializing concurrent catalogue publication
remains the named publication-fence limit; no catalogue write privilege or
runtime escalation is added.

J-S6 now previews a cadence-only edit with frozen agreed money, then appends a
valid shared product-document revision with changed exclusion keys. Applying
that stale preview refuses with `subscription_edit_quote_drift`, preserving
template version and cadence. A fresh preview with unchanged current facts
applies, and the original completed opt-in key still replays after later subject
drift. This extends the existing case without increasing the suite count.

The final follow-up run passed 17/17 journeys per configuration (34 total,
52.7 seconds), with no failures, skips or retries. Both disposable installations
applied 106 history units and zero on repeat. Their restricted `starter_runtime`
login still has SELECT and no UPDATE privilege on all three catalogue tables.
The same serving reader bytes were checked in both hosts. No catalogue lock,
extra grant, template backfill or substitute preview was used.

Store compilation passed with zero errors; all 65 focused source tests and 42
component cases passed. The paid-mail file passed 9/9 once, guest transfer 2/2,
and installed checkout/quote 3/3. Lint (zero errors, 33 existing warnings), the
suppression scan and publication policy passed. Published-tree typecheck found
zero unresolved edges and zero consumer errors against ceiling zero. All owned
containers, volumes, image tags and hosts were removed, along with the disposable
keyring. These remain local development-candidate results.

The current local 0.36.0 artifacts were:

| Artifact | SHA-256 | Packed bytes |
| --- | --- | ---: |
| `openlup-core.tgz` | `3818515857bf4b31c63d61bcb216d849b914af017cbfafbe0a342d8ed19f916d` | 183143 |
| `openlup-outbox.tgz` | `e723db165b4e55166180b2b962191e80e5bbc5735d851e9de20a2e93877f3af0` | 41203 |
| `openlup-platform.tgz` | `44bc1a0cf28c5a668ad61b034d4847ecbece9002a211b8c66ce68ca6d3927d37` | 2604739 |

## Clean-directory and startup witness

Extract into a new empty directory, outside the source archive. Verify the new
Git root, absence of workspace/parent configuration, exact package identities,
installed guides and lockfile integrity. Start with only the documented clean
machine prerequisites. Time the single `./lifecycle up` command from invocation
to ready database, seeded catalogue and responsive application. Then use a real
browser to complete the order and inspect durable state through the package
ports. Record startup duration, intervention and any missing step.

No manual SQL, source edit or secret may be introduced to make that cold path
pass. No manual fixture insert may stand in for purchase-to-subscription
activation. Fault, replay and wrong-actor assertions must preserve the engine's
money, idempotency and subscription invariants.

## Upgrade witness

Commit the independent app, customize identity/layout/minimum through owned
inputs, then use a real installed `openlup upgrade apply`. Record prior and new
package/schema identities, owned hashes and browser results after upgrade.
The CLI must be available from the selected public artifact. The wrapper refuses
while it is absent. Copying files manually is not this proof.

## Current results

On 2026-11-01, the unchanged three-package 0.36.0 set was built and packed from
source commit `bb0008481a11267ec6dbe3e7e531299777cddc19`, labelled as base-version
development candidates without pending native deliveries. Candidate import and
locked application installation passed. Strict application typecheck, Vite build
and 34 pure tests passed, as did root structural, published-tree type and lint
checks. The candidate lockfile and tarballs remain ignored generated inputs.

Playwright 1.62.0 used the existing Chromium revision 1234 cache. Both supplement
and coffee runs passed 34 UI specs each: all fifteen message destinations in both
locales, cart persistence across reload and visible named refusals. Each run also
failed the unchanged required purchase spec; its page displayed
`host_binding_required`. Neither spec was skipped or changed to accept refusal.
Default Playwright config lookup discovered the same 35 specs as explicit lookup,
so the manifest uses `playwright test` without an unnecessary config flag.

A subsequent preliminary-feedback repair run passed 39 pure tests, strict app
typecheck/build and the three root checks. Each configuration passed 36 browser
UI specs and retained the one required purchase failure, with zero skips. Added
regressions cover preserving safe below-minimum selections across reload/storage
events, removing supplied prices, rejecting unknown SKUs and refusing checkout
before its binding. The browser also checks visible payment-method setup and
saved account draft refusals on account and limits pages in both locales.

This establishes a runnable base UI only. No Docker startup, manual-migration-free
cold path, durable order, subscription, valid signed-grant lifecycle, real upgrade
or hosted qualification is claimed. Package/store bindings and final pins remain
pending. The task record retains scope and evidence; the development-candidate
results do not qualify a release or a customer environment.

## Extraction and seed reconciliation

The source suite now passes 54 tests. Archive-only extraction tooling, its test
and the instruction template are classified `sourceOnly`; the materialized
application retains 53 pure tests and runs them without archive files. Managed
offer fixtures set explicit minimum, discount and shipping boundaries instead
of assuming adopter settings. Both configurations have a successful minimum-three,
10000-minor shipping-threshold witness and a below-minimum refusal.
The new-route instructions name the owned page, shell dispatch, localized route
map and ownership changes explicitly.

The install-only seed passed a local PostgreSQL 16 proof using the base
catalogue creation, attributes, document-revision foundation and validation
migrations. A dedicated non-superuser install login applied each configuration
twice; every persisted column was unchanged on repeat. Runtime readback found
six products, six SKUs, two price lists and six prices across both configurations.
An unmarked database and the runtime login were refused; a direct runtime insert
also failed with SQLSTATE 42501. The owned throwaway container was removed.
This is a four-table data-composition proof, not a packaged installer or complete
portable-rail qualification. At that earlier stage the installed bootstrap binding was absent,
and `./lifecycle up` refused `starter_installation_binding_required`.

At that checkpoint, both configurations passed 38 browser UI specs, including the six N5 actions on
account and limits pages in Polish and English and the visible inventory-traceability
boundary. Each retains the single unchanged required purchase failure with
`host_binding_required`. No native purchase or upgrade result follows from these
passing UI/seed witnesses. The independent extraction recipe additionally uses an exact source snapshot
and its own artifact installation; its immutable identity and timed results
accompany the stabilized source read.

## Installed bootstrap follow-up (2026-11-02)

Local development candidates at equal version 0.36.0 were packed from the
merged source `d1aab33e2e4d7448ee9e638c3ed8a08828f67953`, including the complete
installed history. They are not published release pins. The frozen source
archive tree for the Docker witness is
`466a832288dc6b6f48ccd31e7459b1d4feaeaf0d`; its independent extraction had no
installed dependencies or existing Compose database. Candidate import generated
the lockfile before the single startup command. The Node and database images
were already cached; the application image was built during startup.

| Command boundary | Elapsed seconds |
| --- | ---: |
| First `./lifecycle up` to healthy app | 18.393 |
| Second `./lifecycle up` | 5.771 |
| `./lifecycle down` | 0.602 |
| `./lifecycle up` with preserved volume | 8.227 |
| Other configuration (earlier interface) | 7.109 |

Those early measurements used the former configuration interface; the current
flag interface is documented in the README. No intervention, keys, source edits
or manual migrations were needed for those commands. All 95 qualified-v2 history units applied through the installed API;
repeat startup applied zero. Runtime readback matched every authored seed column,
first for supplements and then coffee: six products/SKUs/prices and two lists
across both. Repeated startup and stop/start preserved complete table readbacks.
The configuration endpoint served the selected configuration each time.

The actual runtime login/current role was `starter_runtime`. UPDATE on each of
the four catalogue/price tables and switching to the install role failed with
SQLSTATE 42501. From the application container, privileged TCP logins failed
with 28000 and the install socket was absent (ENOENT). Inspection confirmed no
install connection environment or socket mount and loopback-only application
publication. The database port was unpublished. A separate negative probe
substituted a pre-existing unmarked database: startup refused before marking
or migration; it stayed unmarked. That diagnostic substitution was removed,
and every proof-owned container, application image and volume was removed.

The existing required platform cold consumer additionally runs source pure
tests, independent extraction, an offline install of the three local candidates
and already locked dependency tarballs, extracted pure tests, strict typecheck
and build. Its first measured addition was 13.994 seconds. Source tests passed
70 cases and extracted tests 68, with no skips. Browser journeys remain a
separate recipe; their single required purchase assertion must still fail until
the native purchase binding lands. This bootstrap proves no durable purchase,
subscription, valid-grant lifecycle, upgrade, publication or hosted qualification.

After reserving the missing-binding code exclusively for an absent installed API,
the final runtime source was extracted again at tree
`f98f4d32cf198b493809b20e39e2e1f4bb3c9273`. This run passed the same complete
bootstrap, configuration, replay, persistence and unmarked-database probes.
Startup took 12.077 seconds with cached build layers, warm startup 5.419 seconds,
and startup after down 8.055 seconds; coffee took 6.920 seconds. Runtime INSERT,
UPDATE, DELETE and TRUNCATE were each denied on all four seeded tables. All
proof-owned resources were removed again. Neither timing includes candidate
import (4.024 seconds on this run) or the resource-admission wait.

Both full browser recipes passed 38 UI specs and failed the one unchanged
required purchase spec, with zero skips; both saved failure contexts show
`host_binding_required`. Root lint passed with zero errors and 33 existing
warnings outside this change; the structural scan and published-tree typecheck
passed, with zero unresolved edges and zero consumer-side errors.

The stabilized source reran the same required cold-consumer addition in 13.930
seconds: 70 source and 68 extracted tests passed, strict typecheck and build
passed, and installation used only locally packed inputs offline. The initial
13.994-second measurement is retained above. No gate budget or command changed.

## Origin and native read composition follow-up (2026-11-02)

The source and extracted-copy test layout pass 168 source tests, zero skips,
with strict app typecheck and build. Exact candidate identities accompany the
stabilized source evidence. The local three-package 0.36.0 development candidates
were packed from main `420e68ef843092a174b84461a2bcb4882bca3c03`; no package
implementation changed. They are not published pins.

Each example configuration ran against the complete installed PostgreSQL history
using its own local proof resources. Supplement startup took 25.669 seconds and
its HTTP proof 1.570 seconds. Coffee startup in a fresh database took 10.724
seconds and its proof 1.567 seconds. Images/layers were cached. The first attempt
to reuse the same operator immediately across configurations hit the native
one-challenge-per-minute limit; the isolated coffee witness preserves that
refusal and changes no limiter or authentication behavior.

The proof used native account writers for two demonstration contacts and native
operator bootstrap/invitation activation, then native challenge delivery and
redemption through the HTTP host. It checked profile ownership despite supplied
browser identifiers, separate customer sessions, reduced subscription-control
and order lists, newsletter read/withdraw and grant refusal, reduced OMS list,
no-session/wrong-actor/customer-as-operator refusal, invalid or replayed challenge
refusal and sign-out revocation. The captured mailbox file was mode 0600 and
session cookies had the required local HTTP attributes. All database work used
the runtime login; no install credential entered the host.

Both databases contained zero orders and subscriptions. Native missing-order
refusals passed, but positive order/detail, historical captured-money behavior,
other-customer order ownership and the purchase/account/operator browser journey
remain unverified. No order, payment, subscription terms or method-state rows
were inserted to manufacture evidence. Shipment reads and invoice artifacts
remain unbound. All proof-owned containers, volumes and application image tags
were removed. These results do not qualify deployment, publication or a release.

Pure origin tables and spawned raw HTTP witnesses cover exact Host/Origin,
lookalike/unknown/duplicate headers, missing/null/wrong-scheme/wrong-port Origin,
HTTP opt-in and pre-Docker startup validation. Bounded scratch mutations detect
each removed guard, including lifecycle validation separately. The positive
pinned baseline passes. Root typecheck has zero unresolved edges and consumer
errors; the three existing focused boundary/import/projection files pass 3,051
cases. No package control or dependency changed.

The unchanged required purchase browser assertion ran once in each configuration.
Both failed at the missing completion path with `host_binding_required` visible
in the saved page context, zero skips, in 62.227 seconds total. No browser
assertion changed; these failures retain the pending purchase acceptance.

## Native partner intake recipe

`browser/native-intake.proof.ts` is an explicit real-PostgreSQL Playwright recipe,
separate from the default UI-only server configuration. Run it against a fresh
local demonstration installation with its runtime connection mounted. In the
proof's own disposable database, use the native identity store's
`bootstrapFirstAdministrator` and account-link store's `createAccount` to prepare
fictional operator and customer contacts. Do not insert inquiry, order, review
or grant rows. The browser submits the inquiry and activates the invited human
operator through the real email/token forms and private captured mailbox; the
harness alone reads the mailbox.

Select this file with `testMatch: 'native-intake.proof.ts'` in a local Playwright
configuration, `testDir` pointing at `browser`, and one worker. Set the `use`
options `baseURL`, `composeProject`, `operatorEmail` and `customerEmail` for the
proof-owned installation. Run from the application directory so the recipe's
Docker Compose commands select that project's existing `compose.yaml`. The
recipe restarts only that application's service and waits for the native
one-challenge-per-minute limit before reauthentication. Remove its disposable
containers and volumes after proof.

This recipe checks mounted status, the public submit/replay, native deduplication
and independent peer/email quotas, operator transition and stale-version refusal,
customer-as-operator refusal, invalid/nonexistent/wrong-kind grant refusals and
persistence after host restart. It creates no purchase or review grant. Actual
expired-grant refusal, positive review submit/read, publish/hide with a real
review, grant expiry/revocation and purchase-generated grant ownership are carried
to the purchase composition contribution's acceptance. They are not proved here;
a nonexistent reference is not an expired-grant witness. The unchanged required purchase browser test remains
required and failing while purchase is unbound.

## Native support and catalogue recipe

`browser/native-operator.proof.ts` runs only against a fresh disposable local
installation with the runtime connection mounted. Select it using a local
Playwright configuration with `testDir` pointing at `browser`,
`testMatch: 'native-operator.proof.ts'`, one worker, `use.baseURL` and
`use.composeProject` matching that installation. Run from the application
directory. It creates fictional contacts with the native account writer and
bootstraps/invites the first administrator with the native identity store; the
browser requests the operator challenge through the email form, reads the token
only in the harness from the private captured mailbox, then redeems it through
the separate password token form to activate and sign in. Both locales render
localized labels. Missing-field tests explicitly bypass HTML required validation
to observe starter_input_invalid from the unchanged host; an exact-shape wrong
token reaches starter_auth_invalid. No token is logged or rendered in responses. It inserts no
hand-written business or membership rows.

The sole manual INSERT is exactly the README's documented owner-connection
support-roster step, after native activation and the owner principal lookup.
The recipe proves native not-provisioned refusal before that step, search and
customer detail afterwards, then refusal after owner deactivation. The native
adapter hides its SQL cause behind `customer_support_read_failed`; a separate
runtime SQL probe observes `communications_operator_inactive`. The UI explains
that provisioning is one possible cause and does not invent a more precise error.
No-session, customer, invalid-session and supplied-actor refusals are separate.
Repeated successful and refused support reads compare live PostgreSQL connection
counts to detect a missing `finally` close.

The same recipe exercises bundle list/detail, draft creation, composition, target
price, activation/readback, deactivate/archive/restore/clone, invalid input,
state refusal and command replay. Catalogue draft create/read/list/revise/abandon
and replay use the native handler, registry and store; actor and command key are
host inputs. Effective runtime EXECUTE privileges are checked for all required
routines and helpers without adding grants. The source configuration remains
identical after activation: native catalogue state is not the storefront offer.
Both example configurations require independent fresh databases. Remove only the
proof project's containers, volumes and image tags afterwards.

This recipe does not create a purchase, publish a catalogue draft, add a live
product/SKU/price/promotion writer or prove provider, deployment, upgrade or
release qualification. The required purchase browser assertion remains required
and failing until its native binding lands. This contribution adds no package
implementation or release pin; its decision packet records the measured local
results and exact source/artifact identities.

The acquisition recipe and results below record the earlier acquisition-only
baseline. Its support-binding assertions apply to that baseline; the current
combined installation uses the support and catalogue recipe above alongside the
acquisition journey, with the additional bindings counted and native roster
refusals retained. Acquisition semantics and seed admission are unchanged.

## Native acquisition recipe

Acquisition submission is a public durable write using the adopter-owned registry
loaded under the acquisition foundation migration header contract, lines 16-17.
`browser/native-acquisition.proof.ts` selects a fresh disposable installation,
never the default UI-only host. Use one worker and set `baseURL`, `composeProject`,
`operatorEmail`, `operatorRef`, `customerEmail` and `customerRef` from the native
identity bootstrap/account writers. Run from the application directory. The
browser submits only a location choice ID, email, explicit consent and locale;
it checks success/replay, contact conflict, both quotas and raw-registry-field
refusal. The test harness reads the durable case through the native list port
using the activated operator actor, without adding an acquisition operator route.

The same recipe keeps support search/detail unbound: it checks no-session,
customer and payload-actor refusal, then host_binding_required for an admitted
human operator, and probes the native support port's additional roster failure.
That is seam evidence, not positive support acceptance. Bundle administration
remains unbound under N1. Before running the browser, separately exercise repeat
installation and a deliberately conflicting address-registry row through the
install connection; retain the failure and restore the intended fictional seed.
The required purchase test remains unchanged and must still fail until purchase
is bound. The new recipe establishes no purchase or review-grant lifecycle proof.

The acquisition recipe passed locally on 2026-11-03 with both configurations and
fresh installed PostgreSQL histories. Both use locally packed 0.36.0 development
candidates from main `79ebda3dbd082858ef667c45023246b32eebb9af`, not published
pins. Submit/replay, duplicate contact, quotas, unchecked consent, unknown choice,
raw-field refusal and native-port durable readback passed. Repeat installation
preserved the complete registry row; a conflicting provenance failed installation
loudly. Support remained unbound with its roster seam reproduced. The existing
partner/review regression passed in both configurations. The default browser
suite passed 92 UI checks and retained exactly two unchanged purchase failures,
with zero skips. All proof-owned resources were removed; no purchase, positive
support, catalogue administration or release qualification follows.


## Database-backed purchase acceptance recipe

For the complete purchase and subscription-care gate, run from the installed
application directory:

```sh
./lifecycle browser
```

This command creates fresh PostgreSQL installations and restricted hosts for
both configurations, then writes `.context/database-ui-hosts.json` with loopback
UI origins and `.context/care-browser/fixtures.json` with private care material.
The care file matches each project ID and origin to its runtime/owner connections
and mailbox directory; it is mode 0600 and never served or committed. Trace,
screenshot and video capture stay off. The command runs both acquisition tests
and the `database subscription care` group, then removes its hosts and containers.
To run just those affected specs with the same setup, use
`./lifecycle browser browser/acquisition.spec.ts`.

Only the care group requires the private care file. The default
`npm run test:browser` preview excludes that group and does not need it; its
unchanged purchase witnesses still require a native database host to pass.
The manual host recipes below run the purchase baseline with that group excluded.
They do not qualify subscription care; use `./lifecycle browser` for that gate.

Default Playwright starts database-less previews for navigation and visible
refusals. Those hosts cannot qualify purchase. The separate database-backed
config uses the unchanged required purchase spec and disables trace, screenshot
and video capture because request bodies contain private order capabilities.

Install/seed the complete selected package history using lifecycle. Start one
demonstration Compose project per configuration with `./lifecycle up` and
`./lifecycle up --configuration coffee`. The application container checks the
database demonstration marker, creates its private mode-0600 keyring in
`.context/quote-acceptance-keyring.json` if absent, and passes
`--quote-acceptance-key-file` to the host. A restart of that container reuses the
file; recreating it, including `down` followed by `up`, generates a new key and
unsubmitted quotes need refresh. Compose publishes the fixed loopback port 4319;
run these lifecycle configurations sequentially. These two lifecycle commands
do not create the two distinct origins in the browser configuration below.

For the two-origin browser run below, start one host per configuration outside
lifecycle on distinct loopback ports. Supply the documented `--database-url`,
`--configuration`, `--port`, `--listen` and `--quote-acceptance-key-file <path>`,
using the restricted installer-managed runtime role. Supply your own private
JSON keyring: `current` and optional `previous`, each at least 32 characters.
Keep the file outside served assets and browser configuration, mode 0600, and
never commit it or write it into `.context/database-ui-hosts.json`. Without the
flag, subscription quotes refuse `starter_quote_acceptance_key_required` while
one-time checkout still works.
Write only loopback UI origins to `.context/database-ui-hosts.json`:

```json
[
  { "id": "supplements", "baseURL": "http://127.0.0.1:4319", "composeProject": "starter-proof-supplements" },
  { "id": "coffee", "baseURL": "http://127.0.0.1:4320", "composeProject": "starter-proof-coffee" }
]
```

```sh
npx --no -- playwright test --config playwright.database.config.ts --grep-invert 'database subscription care'
```

### Run the installed browser gate locally

Prerequisites: pinned Node/npm, Docker, `npm ci` at the source root, and
Chromium installed with `npx --no -- playwright install chromium`. Prepare an
extracted application with candidate artifacts from the selected committed
packages using the [candidate recipe](../README.md#run-the-local-application).
Use new Compose project names so each configuration gets its own fresh database.
The fixed published port requires sequential runs. From that prepared application:

```sh
mkdir -p .context
cat > .context/database-ui-hosts.json <<'JSON'
[
  { "id": "supplements", "baseURL": "http://127.0.0.1:4319" },
  { "id": "coffee", "baseURL": "http://127.0.0.1:4319" }
]
JSON
PROOF_RUN_ID="$(date +%s)"
for configuration in supplements coffee; do
  export COMPOSE_PROJECT_NAME="neutral-browser-${configuration}-${PROOF_RUN_ID}"
  ./lifecycle down
  ./lifecycle up --configuration "$configuration"
  npx --no -- playwright test --config playwright.database.config.ts --project "$configuration" --grep-invert 'database subscription care'
  ./lifecycle down
  docker compose down --volumes --rmi local
done
```

Each invocation selects only the project matching the active host; the two JSON
entries intentionally share the sequential loopback origin. Both projects must
pass, including the unchanged required purchase cases.

Then, from the source root with the same committed packages and Chromium present:

```sh
unset OPENLUP_STACK_BASE OPENLUP_BUILD_OUT_DIR OPENLUP_SSR_OUT_DIR OPENLUP_REFERENCE_PROFILE OPENLUP_VITEST_EXCLUDE_FILE
npm test -- --run tests/postgres/neutralStarterE4.test.ts tests/postgres/neutralStoreRecovery.test.ts tests/postgres/neutralStoreRenewal.test.ts --reporter=verbose --maxWorkers=1
```

`npm test` builds its package prerequisites. Docker supplies disposable real
PostgreSQL; no external database or provider credentials are needed. The new
browser cases build their UI assets and disable traces, screenshots and video.
Private mode-0600 fixture files are removed in teardown. Recovery reuses its
existing HTTP host; renewal uses the host's selected restricted installation,
executes the sandbox job once, and signs the customer in through the email and
captured challenge forms. The account controls show the exact projected next
charge amount/currency/date and the renewal order reference/total, including the
first purchase's retained 640-minor shipping charge in that order.

In verbose output require these cases to pass, with both configurations named:

- `runs the separate browser spec in both installed configurations without changing the purchase witness`
- `runs the recurring recovery browser journey against PostgreSQL`
- `runs the renewal effect browser journey against PostgreSQL`

The first case also prints two Playwright project passes; each of the other cases
prints its browser test pass. A downward arrow or skipped `runIf` is missing
browser evidence, even if the overall command exits zero. Hosted runners without
Chromium retain the HTTP/database proofs and cannot qualify these browser cases.
This gate proves local sandbox journeys, not provider, deployment or release
qualification. Subscription and operator command refusals remain in their
existing browser journeys; this recipe adds no command workflow.

Record exact source/artifact identities, installed/repeat migration counts,
both configuration results, capability refusal/replay cases and cleanup. This
JSON alone supplies no database: never substitute a preview or fixture response
for installed PostgreSQL. The required purchase file receives no sign-in step
or other edit. Later sign-in uses the checkout e-mail and private captured native
challenge token, never a seeded customer row.

Four parallel `install-browser` shards under the required `install-proof`
aggregate run `journey.spec.ts` and `acquisition.spec.ts` in both configurations through
[`starter-browser-ci.mjs`](../../../scripts/starter-browser-ci.mjs), after the
shared `install-packages` gate. Official artifact actions transfer only its
verified public tarballs and manifest. Each shard extracts the starter, verifies
the manifest and expected commit, installs those tarballs, and runs its selections in `browser-groups.mjs`, giving each group a fresh pair of
configuration installations. The local `./lifecycle browser` recipe reads the same
module. Later, more specific patterns take precedence; the remainder covers all
other journeys, so a new group needs one additional pattern. This keeps the
unchanged checkout quota active while each selected case runs once. The runner
starts an isolated disposable PostgreSQL 16 per configuration and group through the shared
test helper and pinned `test-postgres` image. Each receives the complete selected
history, repeated installation and its own repeated seed; two loopback hosts use
the restricted runtime login. Separate installations preserve a unique active
price list for each demonstration market. The separate package job starts its
PostgreSQL 17 service after GHCR login.
The browser image comes only from authenticated, digest-pinned
`ghcr.io/openlup/playwright` through the shared image reader and pull loop.
Mirror failure refuses; CI never downloads browsers or pulls a vendor image.
The database config retains one worker and disables traces, video and screenshots.
The runner writes the same private care fixture as `./lifecycle browser` and
starts each host in its own care state directory. Application inputs are mounted
read-only; the care directory alone is writable, with the browser running under
the host user identity to preserve private capture permissions. Cleanup removes temporary results,
captured messages and private keys; the captured output is scanned in memory. No browser output is uploaded.

From the source root after the package gates, run the same script with
`--manifest <package-gates/packages-manifest.json> --expected-commit <full-sha>`.
Add `--groups 0,3` to select zero-based groups; omitting it runs all groups.
The CI shards select `0`, `1,6`, `2,4` and `3,5`.
Docker supplies the disposable PostgreSQL 16 installation; the shared helper
preserves its existing mirror/upstream pull rules and cleanup. The runner removes
its database containers on success and failure. Local development may first pull
the same pinned digest from the Microsoft registry, then pass its complete reference with
`--local-image`; the script verifies the existing local RepoDigest and refuses
this exception whenever `CI` is set. It performs no upstream fallback.

This CI selection covers navigation, localized forms/refusals, cart persistence,
one-time sandbox purchase, discounted subscription acquisition and the database
subscription-care group. Dedicated operator-document, recovery and renewal browser
proofs above retain their own fixtures and local invocation; those separate specs
are not selected by the database config.
A green required job establishes only these selected sandbox journeys, not
provider, deployment, upgrade or release qualification.

Guest one-time and subscription purchases, activation with renewal attachment,
later sign-in ownership, operator order reads and next-parcel address changes
have host-level real-PostgreSQL proofs in both configurations. The measured
three-package application delta is zero bytes against the committed dependency stack.
An earlier database-backed UI run passed 98 checks (49 per configuration), including
both unchanged required purchase cases, with no failures, skips or retries.
The HTTP-only recovery cases need no starter UI assets or Chromium. The guarded
root browser cases above build their assets when Chromium is present; their
results remain local evidence. Separate local browser proof covers captured recovery mail opened in a fresh
context, URL cleanup/reload, an actual host-process restart, paid-link confirmation
without controls, native-clock expiry and revoked/unknown/cross-order/cancelled
refusals. Sign-in exposes the order and activated subscription with completed
renewal attachment. Both localized address results render after sign-in: the
customer writer returns next-parcel application; immediate application is only a
result-display fixture, not a native customer action. Captured responses and
host/error logs are scanned for raw credentials. The Docker cycle freezes source
inputs before image build and compares the live container files, then checks
restart/mail/payment and removes its own containers and named volumes. This
local evidence grants no hosted, provider or release qualification. Positive review and moderation,
revocation and ownership move to the later delivered-shipment review journey;
native thirty-day grant expiry has no application time seam.


## Interim mode-price draft proof

The earlier bounded pricing proof runs separately at the native draft
boundary with clientId null; this is a test of the public draft factory, not an
offered clientless checkout. Use a fresh installed demonstration database for
each configuration, apply only the owned seed, then create subscription and
one-time drafts through `createPostgresNativeCheckoutPersistence`. Reduced unit
prices must match the seeded subscription entries, discounts must be empty and
stored lines/totals must equal the server quote. Do not insert orders by hand.

Repeat installation must apply zero migrations and add zero seed rows. Compare
persisted price facts, assert seed conflicts for a changed configured price and
native refusal for a quote whose price no longer matches the installed entry.
The pure characterization fixes per-unit floor-to-quantum:1499 at5% with quantum10
resolves1420 before multiplying quantity. Owned rate, quantum and demonstration
values must be replaceable without managed code edits. This proof establishes
no recovery, contact creation, activation or browser purchase result.

Attempt limits live in one process's memory and reset on restart.
Checkout applies the configured attempt window, e-mail and requester counts, retention and capacity before contact resolution. Exact replay means the same command key, normalized e-mail and requester; it is free of further quota counts. A retained key with a changed identity is refused before contact resolution, including with a replacement quota callback. The synchronous host binding keeps identity digests within the same retention and capacity bounds; it fails closed when full. Denied quota attempts add nothing to the quota counts. Both process-local records reset on restart. Unpurchased contact retention belongs to the host.


Existing source continuation tests use storage and location stubs to check an
unchanged second submit, completion, a cold module reload, different-order
separation and a replacement token. The committed continuity proof consists of
these source tests and the clean-index root proof. A real-browser second-submit
check was confirmed in a local run that is not part of the committed suite.
The root real-HTTP PostgreSQL regression needs only the three package builds;
it uses neither starter UI assets nor a browser. It checks cadence 120 acceptance
and cadence 121 refusal before any contact write. The shared e-mail boundary
checks a 160-character guest
purchase through payment, native challenge, sign-in and account order visibility;
161 characters refuse before any contact write. A lower configured value governs
both purchase and challenge requests. Address changes check the same phone and
postal-code bounds as checkout. Each case has an explicit 30-second timeout;
run new PostgreSQL cases in the default zone and both offset zones.


An earlier recurring-recovery and renewal PostgreSQL baseline passed 21 cases with
no skips on the selected native installation, including its command receipt-lock
completion. Both operator cases prove issuance, immutable artifact capture/replay,
missing-artifact and changed-context refusal, process restart and revocation by
another active human administrator. The authenticated recovery case scans the
same host log stream for its raw token after real HTTP recovery. Consumer
installations are isolated per setup and removed in teardown. The guarded browser cases above add local recovery and renewal evidence;
without Chromium the HTTP/database cases still run, but browser proof is missing.

The authenticated recovery proof also releases four concurrent account requests
from a real PostgreSQL lock barrier and requires every owned renewal projection
to complete. The host releases its actor transaction before the separate
renewal read borrows the same bounded pool; queries and authority checks retain
their existing owners.

## Paid-order message witness

[`neutralStorePaidMail.test.ts`](../../../tests/postgres/neutralStorePaidMail.test.ts)
installs the canonical catalogue in disposable PostgreSQL and claims through the
restricted runtime login without extra grants. It invokes the actual lifecycle
entry with renewals disabled, observes exactly one private paid receipt with
recipient reference, localized subject and frozen totals, then proves replay is
inert. A competing claim is fenced; a lost acknowledgement followed by lease
expiry reuses the original receipt before reading a changed contact. Unpaid and
cancelled purchases produce none. The same file checks every unselected send
method's refusal, missing-locale/empty-subject validation, private permissions,
immutable capture and corrupt-identity refusal. These are local capture witnesses;
no real mail delivery or provider qualification is claimed.

The same file also creates real purchases through the starter's bound checkout
and sandbox-payment actions, which emit both settlement and paid-email events.
The fixture owner changes only the generated events' `created_at` values to
explicit UTC instants, forcing each sibling order independently of random UUIDs.
Each order is exercised once: the dispatcher captures one paid receipt and replay
adds none, while the unclaimed settlement fact retains its row and version and
creates no message. The settlement-first case fails before the vocabulary fix;
the paid-first control already passes. No hand-inserted event substitutes for the
real purchase in these two cases.

The final stacked paid-mail file passed 9/9 three consecutive times on 2026-11-06
(7.68 s, 7.56 s and 7.54 s), without skips or retries in those runs. It retains
both settlement-ordering cases and the sized/classic parcel-note witness. The
servicing fixture first completes two actual introductory renewals, then opts
one subscription into sized servicing and pays another renewal for each. All
eight resulting paid-email rows are claimed and captured. The final sized
receipt includes its frozen quantity/identity/cadence note; the classic binding
and acquisition receipts omit it. Introductory receipts are separately checked
for captured order and recipient identity. The servicing fixture hides no event,
alters no event timestamp and marks none processed manually; the separate
settlement-ordering witnesses above retain their explicit timestamp controls.

## Shipping amount witnesses

The installed real-PostgreSQL `neutralStoreQuote.test.ts` witness covers both
configurations: paid shipping below the threshold, free shipping exactly at and
above it, and a product discount crossing below it. It compares live quote,
checkout response and persisted order money. Accepted shipping terms flow through
activation into renewal pricing and the separate `shipping_charge` adjustment;
changing current offer settings cannot change the retained agreement. Replaying
the frozen renewal adds no second charge. Source tests replace the former
zero-shipping refusals with configurable paid shipping and invalid-value checks.
Scratch mutations remove the threshold comparison and retained shipping wiring to
check that these witnesses detect the corresponding regressions. Browser purchase
recipes retain their existing carts and expectations; both demonstration offers
charge 640 minor units below a 1,000-minor threshold. These proofs establish no
provider access, publication or deployment qualification.


## Account, checkout and parcel candidate

Run `./lifecycle browser` from the application directory for the complete database
configuration. It creates a fresh installation pair for each of the seven groups
in `browser-groups.mjs`: subscription care; portal; recovery extension; combined
operator operations, returns portal and shipment operations; combined payment
guidance, account preferences, embedded browser and billing profiles; payment
retry; and the remainder. Tests use
one worker and tracing, screenshots and video off. Independent processes and
installations keep each group inside the normal checkout quota; production quota
values and admission paths are unchanged. Focus the portal with `./lifecycle
browser browser/acquisition.spec.ts --grep 'portal '`. Playwright's `--list` inventory
selects fourteen definitions in both languages and both configurations, for
fifty-six cases. The external
parcel fixture freezes synthetic carrier contact and supplies normalized provider
facts through existing native owners. The fixture itself mounts no action;
operator pages bind label, handoff and delivery evidence separately.

The recovery journeys distinguish issuer rules: checkout, reminder-wave and
signed-in recovery links end continuation at order creation plus 24 hours and preserve
earlier links; checkout-expiry notices use creation plus 30 days and retain the
terminal source order. Eligible recovery now offers replacement payment while
the source itself remains terminal. Operator issuance revokes earlier links for
the order and ends continuation at the earlier of issuance plus 24 hours or creation
plus 30 days. Expired-policy inspection can still recreate eligible expired or
system-abandoned initial checkouts until source creation plus 30 days. Frozen
quote, content, stock and prior-payment safety refusals remain. A revoked link,
manual cancellation or payment cannot start another payment.


## Expired checkout recovery and order holds

Expired checkout entry inspects the original order and its latest recovery
lineage. Paid and manually cancelled orders have no Pay control. Eligible
expired orders retain a single Pay action: native frozen re-quote validation,
prior sandbox non-settlement evidence and stock admission precede replacement
payment start. Changed commercial facts, unsupported starter content and stock
refusals cannot start payment. Durable draft, lineage and attempt receipts keep
replay on one replacement and one attempt. Replacement-attempt simulator controls
remain bound to the inspected bearer, lineage and durable execution receipt;
reload reads the same attempt, independently of the recreation source link's
continuation lifetime. Captured executions show no simulator controls. Dedicated token pay, exact inline retry and the embedded-browser buyer-link
control are bound for sandbox attempts; real-provider execution remains unavailable.

Hold and release resolve the human administrator before every command and replay.
The database owner provisions one `commerce_operators` row per human admin, with
`id` equal to the native principal ID. Never delete this row: holds retain its
attribution. Withdraw access by revoking the membership through the identity
owner. Distributors and admins without the Commerce row cannot issue or replay
these commands. A locked upcoming cycle refuses an address change with
`payment_blocked`; existing order and parcel destinations remain unchanged.

The additional real-PostgreSQL journeys run in the `recovery extension ` group
from the single shared `browser-groups.mjs` source. Each group uses a fresh
installation pair, one worker and traces, screenshots and video off. Checkout
quota and all runner guards remain unchanged.

The hold witness proves durable replay across a host-process restart with a fresh
native administrator session. It does not prove session continuity or container
restart configuration. Recovery inspection gives terminal results priority over stored executions. An
already dispatched replacement uses its lineage-bound receipt independently of
the source link's continuation; unrecoverable original-order continuation does
not authorize a new attempt or invalidate that replacement execution. Recreated targets refuse the ordinary
sandbox action even for their signed-in owner after a refused attempt. The
expiry-notice journeys click Pay without prior provider evidence and prove the
reference safety refusal with no replacement or payment; display validation
checks the quote, while Pay checks prior-payment safety.

## Unpaid cancellation and manual refund records

The operator first reads the exact order, enters a reason and confirms the shown
consequence. Unpaid cancellation uses the native unpaid-order command and releases
only held purchase reservations. Dispatched, indeterminate and captured payment
evidence can refuse it. It does not cancel a subscription or a dispatched parcel.
Manual refund marking records a paid order as refunded after the operator confirms
that the refund was completed outside this application. This command moves no
money, sends no refund email, creates no fiscal reversal and changes no subscription.
Genuine provider-refund duties retain their existing owners.

Each command and replay rechecks the human admin and resolves the existing Commerce
operator row. Caller identities, missing confirmation, invalid reasons, stale
order status and conflicting commands refuse. Reasons use the package's trimmed
1–2,000 character contract. Native durable receipts own replay. The two formerly
unavailable actions are bound; physical-return, tracking and account limits stay separately
listed until their own complete bindings exist.


## Return intent and optional payment guidance

The return forms now use the native owned-request and administrator decision
ports. Customer journeys request an owned paid order, retain its exact reference,
replay canonical input and refuse foreign ownership, duplicate lines, excessive
quantities and forged identities. Administrator journeys approve full, partial
zero and no-refund intent, reject requested returns and replay changed notes
without changing the original decision. Distributor sessions, missing Commerce
provisioning and withdrawn memberships refuse. The witnesses compare unchanged
order, reservation, payment truth and subscription facts and count the native
decision outbox events. Receiving, restocking and sending a refund remain unbound.

Optional completion guidance uses a native atomic snapshot and the real order
bearer. Journeys cover localized safe generic-decline copy, repeated read-only
inspection, foreign/revoked/expired authority, forged selectors, indeterminate
fallback, initial subscription context and observed capture before settlement.
A unit witness checks missing intent, lookup failure and malformed native output
falling back to the ordinary reader. There is no synthetic cookie, method
identity or evidence taxonomy.

The single shared grouping source adds `returns portal ` and `payment guidance `.
At the return/guidance checkpoint, the generated database-profile listing had
308 cases, partitioned as 62/56/52/12/12/12/102; every case is selected exactly once. Each group receives a
fresh installation pair. Workers remain one, retries zero and all captures off;
the checkout quota stays 36 per 180 seconds.


The affected groups passed all 144 cases on real PostgreSQL in both languages:

| Group | Cases, both configurations | Original checkouts per configuration | Replacement receipts per configuration |
| --- | ---: | ---: | ---: |
| Portal | 56 | 36 | 0 |
| Recovery extension | 52 | 26 | 10 |
| Operator operations | 12 | 10 | 0 |
| Returns | 12 | 8 | 0 |
| Payment guidance | 12 | 10 | 0 |

Both configurations have the same counters. Successful output from every group
passed the unchanged private-output guard against the private captured values.
Starter units passed 319/319; the PostgreSQL integration witness passed 7/7,
including the extracted application browser witness and the 60 declared / 53
bound operation census. These tests ran with `CI=1` and global Git configuration
disabled, using each test suite's native runner.


## Operator shipment commands

Confirmed operator forms bind label, handoff and tracking evidence through the
public native handlers and shipment command port. Every invocation, including
replay, checks active human-admin authority and pins the parcel from fresh detail.
The human principal owns audit attribution; the shipment commands do not require
a Commerce operator row. Invalid identities and unconfirmed input refuse before effects. Unknown targets
for fresh commands refuse; receipt replays retain their native target rules. Native commands run in READ COMMITTED transactions.

The shipment journeys cover label URL/full provider-payload retention, operator
read admission, customer/public-read isolation, exact stock consumption, terminal
and old-key handoff replay, provider-scoped conflicts, unattributed history,
same-order correlation, historical missing reservation sets, exception recovery,
actual replacement arrival, explicit-zone chronology and no-zone fallback.
Earlier/later replay preserves the original private receipt and never moves the
next cycle earlier. Distributor, customer, revoked and anonymous commands refuse.
No undelivered replacement attestation is invoked.

| Group | Passing cases, both configurations | Original checkouts per configuration | Replacement checkout receipts per configuration |
| --- | ---: | ---: | ---: |
| Portal | 56 | 36 | 0 |
| Operator operations | 12 | 10 | 0 |
| Returns | 12 | 8 | 0 |
| Shipment operations | 16 | 12 | 0 |
| Remainder | 102 | 2 | 0 |

All 198 affected cases passed with the shared database recipe, fresh installation
pairs, one worker, zero retries and traces, video and screenshots off. Both
configurations have identical counters. The checkout quota remains 36 per 180
seconds. The unchanged private-output guard passed for every successful group;
the logs also contain no synthetic private label URL or provider-payload marker.
At the shipment checkpoint, the generated inventory had 324 cases partitioned as
62/56/52/12/12/12/16/102, every case selected once and no duplicate identities.

Starter units passed 320/320 and the PostgreSQL integration witness passed 7/7,
including both extracted application browser cases and the 60 declared / 56
bound operation census. Changed tests use their native runners with `CI=1` and
global Git configuration disabled. New times are current or relative UTC values;
no fixed dates or short expiries were introduced. Public tracking authorization,
physical return execution and the remaining account/payment integrations retain
their separate limits.


## Saved subscription addresses and scoped preferences

The account page binds native saved-address reads, upsert and deletion, explicit
subscription shipping selection, and scoped payment/delivery preferences. HTTP
and browser witnesses cover session ownership, forged identity refusal, address
normalization and null recipients, default clearing, separate-commit event failure,
canonical replay, zero-row deletion acknowledgment, foreign updates/selections,
active/paused in-use refusal and locked upcoming-cycle admission. A real renewal
skips an incomplete subscription locker, selects the complete any-scope courier,
and retains its immutable operation and destination after the saved address changes.
Future destination materialization reads the edit. Preference saves preserve
existing subscriptions, payment instruments, orders and account events.

The scoped billing reader supplies owned profiles alongside saved address rows;
default snapshots expose redacted, unapplied hints. Read errors refuse rather than becoming an empty
book. Only combined profile and private-profile views remain under N5.
Independent extraction still accepts a replacement owned registry without requiring
additional registry exports. Personal-data export/erasure integration retains its
separate application-owner responsibility.

| Group | Passing cases, both configurations | Original checkouts per configuration | Replacement checkout receipts per configuration |
| --- | ---: | ---: | ---: |
| Account preferences | 16 | 6 | 0 |
| Subscription care | 62 | 34 | 0 |
| Portal | 56 | 36 | 0 |
| Remainder | 102 | 2 | 0 |

All 236 affected cases passed through the shared database recipe, with one fresh
installation pair per group, one worker, zero retries and captures off. Both
configurations have identical checkout counts; the quota stays 36 per 180 seconds.
The unchanged private-output guard passed every successful group log, with the
flag absent. At the account-preferences checkpoint, the generated inventory contained 340 cases partitioned as
62/56/52/12/12/12/16/16/102, every case selected once and no duplicate identities.
At that checkpoint, the remaining N5 refusal journey asserted the three actions still unavailable;
new PostgreSQL journeys witness the newly bound actions.

Starter units passed 326/326, including independent extraction, and the PostgreSQL
integration witness passed 7/7, including both extracted browser cases and the
64 declared / 60 bound census. Changed files ran in CI parity with global Git
configuration disabled, using their owned Node, Playwright and Vitest runners.
New tests introduce no fixed dates or short expiries.


## Dedicated sandbox payment recovery and browser handoff

Dedicated token pay binds the latest owned recovery order, intent and reservation.
Exact inline retry uses the real Secure/HttpOnly/Strict continuation cookie,
atomic guidance, expected predecessor and retry nonce. Witnesses cover one-time
and provisional initial subscription dispatch, same/different demo choices,
verified refusal, concurrent nonces, replay through a fresh host process with the
same private signing root, cookie rotation, stale predecessor refusal, captured
settlement and reload. The replay journey owns its private host key from the first
native dispatch, crashes that disposable host and starts a distinct process with the persisted
key. Browser requests navigate to the actual host origin and verify that origin
after replay. Exited children are not awaited a second time. Cancellation journeys
wait for the specifically named cancellation form, independently of earlier order
controls and asynchronous parcel reads. Token and inline retries create no new order or second financial settlement.
A lineage journey retries a declined replacement through the dedicated entry,
keeps one replacement order and leaves the expired predecessor terminal.
Missing or mismatched cookie, supplied identity, real-provider rail, expired or
revoked token and terminal/in-flight state refuse. Native observed capture wins
over stale control availability. Original ordinary continuation keeps its retry
after decline; recreated targets stay fenced to the separate lineage receipt.

Embedded-browser journeys use the measured user-agent hints only for display,
then the actual native cookie for send authority. Send/send-again in one bucket queues
one buyer event, remount retains the confirmation, transport failure keeps retry
reachable, and authorized native outbox delivery captures the link privately.
An independent ordinary browser context opens that real email link without the
embedded tab's cookie, starts a new attempt after decline, and settles the same
order once. Another journey proves ordinary-browser hiding and missing-cookie
refusal after a real legacy sandbox dispatch. No test cookie is fabricated.

| Group | Passing cases, both configurations | Original checkouts per configuration | Replacement checkout receipts per configuration |
| --- | ---: | ---: | ---: |
| Payment retry | 20 | 10 | 2 |
| Embedded browser | 8 | 4 | 0 |
| Portal | 56 | 36 | 0 |
| Recovery extension | 52 | 26 | 10 |
| Payment guidance | 12 | 10 | 0 |
| Remainder | 102 | 2 | 0 |

At the token/inline checkpoint, all 250 affected cases passed on real PostgreSQL
with the single shared selections,
fresh installation pairs, one worker, zero retries and captures off. Both
configurations have identical counters. Original and replacement drafts together
stay within the unchanged 36-checkout quota. All successful logs passed the
unchanged private-output guard, with its flag absent. At that checkpoint the generated
full listing contained 368 cases partitioned as 62/56/52/12/12/12/16/16/20/8/102, every case selected
exactly once and no duplicates.

At that checkpoint starter units passed 332/332, including extraction and owned-registry witnesses.
The PostgreSQL integration witness passed 7/7, including the extracted browser
cases and 68 declared / 64 bound operation census. Changed Node, Playwright and
Vitest suites ran with CI enabled and global Git configuration disabled. New
fixtures use current/relative ordered instants and no short expiries. No complete
native-limit row is removed: real-provider and remaining account boundaries stay.


## Recovery capture and continuation display witnesses

A repeat subscriber has no acquisition terms on the next initial checkout. Native
HTTP and browser journeys pay that checkout through dedicated token pay or exact
inline retry, simulate capture, and require both a paid order and an active
subscription with attached renewal terms. Acquisition snapshots validate retained
renewal availability before recording any capture observation; damaged retained
terms leave the order pending, the declaration provisional and the attempt
dispatched with no observation. A live token for another customer cannot inspect
or simulate the target payment and leaves its durable state unchanged.

Buyer-link confirmation is keyed by the inspected continuation order. Unit proof
keeps each order's confirmation independent across remounts. The owned
`embeddedCheckoutBrowserMarkers` policy controls display hints only; native cookie
authorization continues to own delivery and payment admission. The group partition
unit includes payment-retry and embedded-browser sample titles.

At the initial capture-repair checkpoint, the affected shared groups passed 152 cases: portal 56, recovery extension 52,
payment retry 36 and embedded browser 8. Original/replacement draft counts per
configuration are 36/0, 26/10, 24/2 and 4/0 respectively, identical for both
configurations and within the unchanged quota. Every group uses a fresh pair,
one worker, zero retries and captures off. At that checkpoint the generated full listing
contained 384 cases partitioned as 62/56/52/12/12/12/16/16/36/8/102, with each
identity selected once and no duplicates. Starter units passed 333/333 and the
PostgreSQL integration witness passed 7/7, including the extracted application
and the then-current 68 declared / 64 bound operation census.


## Billing and shared capture activation

The billing journeys cover browser profile creation, editing and deletion; owned
redacted default hints; invalid and forged input; foreign update refusal and
zero-row delete acknowledgement; separate default/write/event commits and repeated
keys without deduplication. Sandbox payment creates the first owed duty with an
explicit buyer, an owned profile/billing address or a marked shipping fallback.
The invoice uses the actual captured buyer, including line2 and provenance.
Recreated profile/fallback cases use the native slot-28 absence-preserving forward.
Later profile edits/deletions leave captured buyers and installed invoice facts
unchanged. The customer invoice page displays the authorized frozen snapshot.

All sandbox capture actions share the pre-capture acquisition check and native
classic/acquisition activation selection. Real-PostgreSQL/browser regressions
require repeat-subscriber token pay, inline retry and recreation to produce a paid
order and an active subscription with attached renewal terms; damaged acquisition
terms refuse before any capture observation. The browser-safe owned display module
contains the three measured embedded-browser hints, which confer no authority.

The shared selection inventory contains 408 cases partitioned as
62/56/52/40/52/44/102 across the seven groups. Playwright listing confirms every
case is selected exactly once and there are no duplicates. Each group still receives a fresh installation pair,
one worker, zero retries and captures off.

Counts below include both languages. Cases include both configurations; checkout
counts are per configuration, whose hosts have independent requester counters.
Original and replacement checkouts together bound even a run that completes
entirely within the unchanged 180-second window, at most 36 per requester.
Replayed commands and payment attempts do not create another checkout.

| Selection, in execution order | Cases | Original checkouts per configuration | Replacement checkouts per configuration | Total checkouts per configuration |
| --- | ---: | ---: | ---: | ---: |
| Subscription care | 62 | 34 | 0 | 34 |
| Portal | 56 | 36 | 0 | 36 |
| Recovery extension | 52 | 26 | 10 | 36 |
| Operator operations, returns portal, shipment operations | 40 | 30 | 0 | 30 |
| Payment guidance, account preferences, embedded browser, billing profiles | 52 | 28 | 4 | 32 |
| Payment retry | 44 | 30 | 6 | 36 |
| Remainder | 102 | 2 | 0 | 2 |

The combined counts follow the definitions in
[`acquisition.spec.ts`](../browser/acquisition.spec.ts), in source order within
each named family. Per language, operator operations creates 1/3/1 originals,
returns portal 2/1/1, and shipment operations 2/2/1/1: twice (5 + 4 + 6) gives
30 per configuration. Payment guidance creates 1/2/2 originals, account
preferences 0/1/1/1, embedded browser 1/1, and billing profiles 1/2/0/1 plus
1/1/0/0 replacements: twice (5 + 3 + 2 + 4 + 2) gives 32. Billing CRUD
creates accounts without checkouts. The payment-retry total conservatively
includes the two originals created on its separate restart-proof hosts.

Later patterns still take precedence: the combined operations selection follows
`portal ` so its `returns portal ` titles are excluded from the broader group.
The generated full-title Playwright inventory selects all 408 identities once.
The required runner retains complete migrations and replay, repeated seed,
restricted runtime-role checks and both hosts per group. A setup failure stops
before acquiring another group and reports its group number and phase. A failure
after Playwright starts retains later groups' diagnostics. Cleanup and the private
output scan still run on either path. [Required checks](../../../CONTRIBUTING.md#required-and-raw-checks)
owns the job layout and deadline policy.

Local Docker verification of the two combined selections passed 40/40 and 52/52
cases in both configurations, with one worker, zero retries and no quota refusal.
Including setup and cleanup, the selections took 80.240 and 75.471 seconds,
respectively. Both outputs passed the unchanged private-output scan. Starter
units passed 336/336; the required-runner witnesses passed 43/43 with CI enabled
and global Git configuration disabled. These local timings do not measure the
hosted job's total duration.
