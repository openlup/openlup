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
