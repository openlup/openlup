# Application ownership
Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#read-the-inventory).

Status: moved to the [OpenLup guide](../../../packages/core/docs/guide/concepts/starter-ownership.md); this page keeps its headings so links resolve. Sections marked "Evidence" are frozen historical records.

`ownership.json` drives `extract.mjs`; the source instruction file remains `AGENTS.template.md` so it does not govern monorepo contributors.

Source-release preparation replaces candidate `file:` pins with exact published pins, removes the candidate lockfile ignore, moves `package-lock.json` from generated to managed, and records the application registry lockfile. Archive creation, package publication and application deployment remain separate release boundaries.

`installation/install.ts` is install-only composition. `host/purchase-composition.ts` injects the public contact dependency and `host/native-composition.ts` owns and closes the role-free checkout-token transaction lane.

The source retains `shared/offer-estimate.ts` for display estimates beside the installed quote composition; it is not a replacement money engine.

Evidence (historical record, 2026-11-13):
The extracted repository retains the inventory, but not its `sourceOnly` files.
Its `npm test` runs application tests only. Source-release `npm test` additionally
runs extraction and refusal coverage, including the materialized test command.

`owned/catalogue.ts` owns the fictional catalogue-draft type registry. Managed
`host/operator-composition.ts` composes support and catalogue native ports. Native
human membership precedes each operator action; the owner alone provisions and
deactivates the separate support roster as documented in the README. No runtime
roster writer or installer roster seed exists. Drafts and bundle activation do
not replace the owned storefront offer configuration. The managed real-database
browser recipe is `browser/native-operator.proof.ts`.

Acquisition ownership below was established before support and catalogue
composition; its final scope statement describes that earlier contribution only.

`owned/acquisition-addresses.ts` is owned demonstration data beside the catalogue
seed. It contains fictional opaque registry tuples and localized choice labels.
The acquisition foundation migration header, lines 16-17, permits an adopter to load its own
replaceable registry through the database owner connection; the managed installer
uses that contract only after its existing install-identity and demonstration
marker admission. Its insert names every column and verifies provenance/active
state after a keyed conflict. The runtime host only reads the owned list, maps a
choice ID and submits through the native port; it never loads the registry.
Support customer reads and catalogue administration remain unbound. Their
composition is outside this acquisition change.

`playwright.database.config.ts` is the managed real-database UI recipe. Its
ignored `.context/database-ui-hosts.json` contains two non-secret loopback UI
origins, never database URLs or capabilities. The proof operator starts those
hosts with installed runtime connections. Browser tracing is disabled because
request bodies carry private capabilities. The required purchase spec remains
byte-identical. Focused regressions live in `test/checkout-recovery.test.ts`.

Editor values and localization are owned in `owned/subscription-editing.ts` and
`owned/editor-copy.ts`. Editor pages/models and the host's session admission,
catalogue verification, package ports and frozen-order parcel-note callback are
managed. `playwright.editors.config.ts` selects synthetic component witnesses;
the database configuration selects the separate real-purchase editor/API journeys.
Each database host entry also names its proof-owned `composeProject` for these
journeys. No database connection or private mailbox token belongs in that JSON.

Four editor witness files in `test/` are source-only: the compiler contract,
package-backed models, host routes and parcel-note callback witnesses. They use
the source release's built package contracts/compiler. The raw extracted app's
dependency-free test phase excludes them; the materialized app retains the
browser recipes and its ordinary tests. This classification does not replace
the source-release witnesses or claim a native database result.

## Paid-order message ownership
Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#paid-order-messages-and-shipping).

`host/paid-mail.ts` and `host/paid-mail-artifact.ts` remain separate managed composition and capture owners.

Evidence (historical record, 2026-11-13):
`browser/renewal.proof.ts` is a managed, fixture-backed local recipe. Its source
PostgreSQL runner supplies the private mailbox and expected account/order values;
the customer uses only sign-in and account read controls. Fixture files and
Playwright configurations under `.context/` are generated private state.

## Subscription care ownership
Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#subscription-care).

`host/scheduled-renewal.ts` and `host/lifecycle-notices.ts` remain managed care composition.

Evidence (historical record, 2026-11-13):
`./lifecycle browser` is the managed local PostgreSQL recipe for the
database browser configuration. Its private fixture connections and host state
live under `.context/care-browser`, never in the archive. It owns and removes
only its newly created containers and child processes. The installed package
migration runner owns the database schema; no starter migration or grant is added.

## Account, checkout and parcel controls
Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#account-and-operator-authority).

`host/e4-composition.ts` and `host/native-composition.ts` compose account and operator authority; `host/paid-mail.ts` owns the separate recovery entry.

## Expired checkout recovery and order holds
Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#checkout-continuation-and-recovery).

`browser-groups.mjs` remains the single browser-group source.

Evidence (historical record, 2026-11-13):
The additional real-PostgreSQL journeys run in the `recovery extension ` group
from the single shared `browser-groups.mjs` source. Each group uses a fresh
installation pair, one worker and traces, screenshots and video off. Checkout
quota and all runner guards remain unchanged.

## Unpaid cancellation and manual refund records
Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#cancellation-refund-records-and-returns).

`host/e4-composition.ts` binds the native order transitions without a separate starter state machine.

## Return requests and decisions
Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#cancellation-refund-records-and-returns).

`host/e4-composition.ts` binds native return intent and exact-reference decisions.

## Optional payment guidance
Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#payment-guidance-and-sandbox-continuation).

`host/checkout-recovery.ts` composes the optional native guidance reader.

## Operator shipment evidence
Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#shipment-evidence-and-retention).

`host/e4-composition.ts` owns the shipment-command transaction boundary; operator detail is separate from customer reads.

## Saved addresses and scoped preferences
Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#saved-addresses-billing-and-preferences).

`host/e4-composition.ts` composes scoped account readers, handlers and destination selection.

## Sandbox token payment and exact continuation
Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#payment-guidance-and-sandbox-continuation).

`host/checkout-recovery.ts` composes sandbox execution and native continuation; the UI display hint is in `client/pages/checkout.ts`.

## Billing profiles and frozen invoice buyers
Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#frozen-invoice-buyers-and-privacy).

`host/acquisition-predecessors.ts` shares initial capture/activation composition; `host/native-composition.ts` owns the programmatic privacy registry.

Evidence (historical record, 2026-11-13):
Install the complete ordered package history through
`20261110280000_checkout_recovery_buyer_snapshot` before starting this composition.
The host requires the slot-27 first-duty buyer-capture entry; slot 28 preserves
absence of explicit buyer facts during recreation. `./lifecycle up` installs the
complete history. No duty or historical invoice is backfilled.
