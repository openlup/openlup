# Starter execution evidence

Status: proof recipe with bounded base-candidate execution evidence below.

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

Both configurations pass 38 browser UI specs, including the six N5 actions on
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
  { "id": "supplements", "baseURL": "http://127.0.0.1:4319" },
  { "id": "coffee", "baseURL": "http://127.0.0.1:4320" }
]
```

```sh
npx --no -- playwright test --config playwright.database.config.ts
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
  npx --no -- playwright test --config playwright.database.config.ts --project "$configuration"
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

The required `install-proof` job now runs `journey.spec.ts` and
`acquisition.spec.ts` in both configurations through
[`starter-browser-ci.mjs`](../../../scripts/starter-browser-ci.mjs), after the
package gates. It extracts the starter, installs the verified candidate tarballs,
starts an isolated disposable PostgreSQL 16 per configuration through the shared
test helper and pinned `test-postgres` image. Each receives the complete selected
history, repeated installation and its own repeated seed; two loopback hosts use
the restricted runtime login. Separate installations preserve a unique active
price list for each demonstration market. The job's existing PostgreSQL 17 service
is unchanged.
The browser image comes only from authenticated, digest-pinned
`ghcr.io/openlup/playwright` through the shared image reader and pull loop.
Mirror failure refuses; CI never downloads browsers or pulls a vendor image.
The database config retains one worker and disables traces, video and screenshots.
Application inputs are mounted read-only. Cleanup removes temporary results,
captured messages and private keys; the captured output is scanned in memory. No artifacts are uploaded.

From the source root after the package gates, run the same script with
`--manifest <package-gates/packages-manifest.json> --expected-commit <full-sha>`.
Docker supplies the disposable PostgreSQL 16 installation; the shared helper
preserves its existing mirror/upstream pull rules and cleanup. The runner removes
its database containers on success and failure. Local development may first pull
the same pinned digest from the Microsoft registry, then pass its complete reference with
`--local-image`; the script verifies the existing local RepoDigest and refuses
this exception whenever `CI` is set. It performs no upstream fallback.

This CI selection covers navigation, localized forms/refusals, cart persistence,
one-time sandbox purchase and discounted subscription acquisition. Separate
operator-document, recovery and renewal browser proofs above retain their own
fixtures and local invocation; they are not selected by the database config.
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
