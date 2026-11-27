# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Stable APIs follow SemVer from 1.0.0; experimental symbols and test-support
subpaths retain their declared limits. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [1.4.0]

- Publishable on the npm `latest` dist-tag as `1.4.0`, from tag
  `openlup-core-v1.4.0`.

- @openlup/core size growth: The packed reader guide adds the 1.4.0 upgrade guide and catalogue and checkout guidance, alongside new catalogue and commerce money contracts.

### Use governed catalogue lifecycle on a new native lineage

Install the complete native catalogue and compose the v4 draft handler and
store for a new product. Withdraw through a publication to close fresh sales
while retaining SKU facts and offer membership. Restore the product and
explicitly restore and enable each SKU intended for fresh sales. Use
`readbackV3` for exact governed facts and the publication receipt reader for
the original versioned receipt. Older lineages require explicit adoption.

### Declare fixed-day subscription profiles

`@openlup/core/subscription` adds versioned cadence choices.
`@openlup/core/catalog` validates profile declarations, returns field-specific
remedies and provides canonical JSON for a SHA-256 declaration digest.
Fixed-day declarations and their optional cap use whole days from 1 to 3660.

### Record the catalogue revision accepted by commerce

The experimental `@openlup/core/catalog` accepted-reference types describe
the immutable SKU identity recorded with a purchase or subscription agreement.

The catalogue extension guide and offline samples use version 3 drafts. The
limits reference describes the starter's operator publication API, the catalogue
tax-class check and how the Core evaluator handles stored promotion targets.

Adds an experimental decimal-percent validator to the pricing entry. It shares
the catalogue money calculator's rate grammar.

- Add the experimental `planCatalogueMoneyV2` and `calculateCatalogueMoneyV2` exports to `@openlup/core/pricing` for basis-aware catalogue amounts, adjustments, delivery, fees and tax. The API documents local rounding and provider evidence. Supply provider tax states in plan order for each component and a payable that includes fees.

Ships a runnable TypeScript catalogue pack and nine installed recipes for checking
owned definitions and fixtures. The static JSON sample remains available.

Migration: Follow [Convert the owned module from 1.3.0](docs/guide/upgrade/v1-4-0.md#convert-the-owned-module-from-130),
then run the starter's `catalogue:check:source` npm script from your application
root. Correct invalid registry definitions before starting the host. Retain the
unit factor migration and follow the starter's installed-rules procedure if
you opt into rule installation. The conversion requires no database upgrade.

### Share original quote and order money

- Use experimental `CommerceMoneyBodyV2` from `@openlup/core/pricing` for the
  shared money facts that a quote commits and an order retains.

Adds JSDoc `@deprecated` notices to legacy 1.x
fulfillment UI label helpers (`stepLabelKey`, `timelineLabelForStep`) and the
legacy `PaymentMethodCaptureHandoff` union, pointing adopters to their existing
1.x replacements (`FULFILLMENT_STATUS_EFFECTS` and `toCoreCaptureHandoff` /
`fromCoreCaptureHandoff`) ahead of 2.0.0.

Migration: no runtime or type changes in 1.x. Adopters can migrate incrementally
to `FULFILLMENT_STATUS_EFFECTS`, application-owned i18n, and
`toCoreCaptureHandoff` / `fromCoreCaptureHandoff` before 2.0.0.

### Report maturity and deprecation in `openlup-context` symbol hits

- `openlup-context` export hits for a symbol now carry `maturity` (`stable`, `experimental` or `testing`) in `--json` output and in the MCP tool's structured hits, and `deprecated: true` for a symbol tagged `@deprecated`. Text output ends the hit with `; maturity <value>` and `; deprecated`.
- A symbol tagged `@experimental` in its own declaration comment, or under a tagged re-export statement, reports `experimental`. Any other symbol reports its subpath's maturity from `release-gates.json`. A hit has no `maturity` when the declaration was not found inside the package, or when no subpath maturity is known and no `@experimental` tag applies; in either case, read the declaration.
- The maturity reference lists, for each package, the symbols whose maturity differs from their subpath's or that are deprecated.

### Expand settings guidance, qualification tests and adoption checkpoints

`configure-settings.md` now defines the five qualification tests for settings,
documents the installed-policy end-to-end flow (including accessing the
demonstration PostgreSQL container over Compose), and provides a command/exit-code
table. Adoption, starter customization, upgrade, configuration reference, and
adopter-kit templates now link directly to `settings list` and `settings check`.
This documentation change requires no installed-policy step.

### Starter browser code imports platform values from browser-safe entries

The starter's `client/quote-acceptance.ts` and `shared/offer-estimate.ts` now take
`acquisitionTermsSchema` and `deriveSubscriptionUnitPrice` from
`@openlup/platform/pricing/browser`, and `ACQUISITION_TERMS_CAPABILITY` from
`@openlup/platform/pricing/contracts`, instead of the Node-oriented
`@openlup/platform/pricing` entry. Behaviour is unchanged. In your own
`client/` or `shared/` code, import runtime values only from a browser entry
(`…/contracts`, `account-support/read-contracts`, `pricing/browser`, `commerce`,
`marketing`, `operations`, `storefront`), use `import type` for types, and keep
host-only modules under `host/`.

Migration: Upgrade replaces pristine copies of both files. If apply reports that
a managed file has local edits, keep your edits separately, restore the file
from the installed starter version, rerun apply and reconcile your edits with
the replacement. A customised copy that still imports from
`@openlup/platform/pricing` keeps working; change those imports to the browser
entries when convenient. This upgrade requires no installed-policy step.

### Rebuild starter catalogue packs after applying managed files

- The demonstration installer publishes one verified rules build per adopter pack version. Save and Prepare require that build for the exact declared type. Offline conformance keeps using owned declarations.
  Migration: Restore required exact versions and their rules under `owned/`, follow the owned-module migration in “Consolidate starter catalogue declarations before demonstration installation”, apply managed files and run `./lifecycle up --json`. Repeat the same draft action.
- The demonstration installer requires each pack identity to fit one UTF-8 filename, including the version and suffix. A build publication failure can follow a committed SQL transaction.
  Migration: Check the pack filenames and the installer volume's write access. Restore matching inputs and replay to recreate a missing link. Use new pack and affected type versions for intentional changes.
- Text `up` adds a Fix line to outer refusals and recognizes registered codes and explicit compatibility cases.
  Migration: Keep text checks on the first line, or use `./lifecycle up --json`, `findings[].code` and the process exit status. Check the upgraded application with a missing rules bundle and a failed launcher.
- The managed-file upgrade installs the refusal module and the lifecycle and host changes.
  Migration: Reconcile divergent managed files against the exact predecessor and target snapshots. Keep owned bytes through apply, then rebuild and check the reported type in the operator form.

### Find catalogue tasks and owned files in the starter

The extracted agent guide maps catalogue tasks to application-owned inputs and
installed recipes. Managed files point to the owned extension point. The
extracted ownership guide lists managed JSON paths under **Managed JSON files**.

Migration: Replace a pristine `AGENTS.md` with the target extraction's copy.
For a customized guide, explicitly reconcile the catalogue task section and
preserve local instructions. Use the target extraction for managed files.
This change requires no startup or policy action.

### Apply an authored product on the demonstration starter

The starter can release a product, authorize its first gross base prices and
activate that same product. The optional copy step publishes presentation on
the retained product and SKU identities. Apply requires the marked demo and a
human administrator who confirms each publication in an interactive terminal.

Upgrade replaces pristine managed lifecycle, operator, installer and action
files together and installs the starter's local media verifier. If
`upgrade apply` reports a conflict, save local modifications, restore the predecessor files
and run upgrade again. Reconcile your saved changes
against the new files before startup. Partial upgrades refuse with
`incomplete_application_upgrade`. Keep your declarations in `owned/catalogue.ts`.
Upgrading requires no sign-in, price write or installed-policy step.

### Consolidate starter catalogue declarations before demonstration installation

Move any still-used declarations and fixtures from `owned/catalogue.json` to
`catalogueConformance.packs` in `owned/catalogue.ts` and run
the starter’s `catalogue:check:source` npm script from your application root.
Upgrade leaves the old owned JSON bytes in place. After verifying the migration, remove a pristine copy manually and archive
or remove a customized copy. Independent inert JSON fixtures can use
`openlup catalogue check --packs` directly.

#### Convert the owned module from 1.3.0

The 1.3.0 starter exports only `catalogDraftRegistry`. Applying the upgrade
preserves the owned TypeScript and JSON files. Before starting the demo, edit
`owned/catalogue.ts` in your application. Keep your existing `types` array and
its validators. Add the `CatalogPackInput` type import from
`@openlup/platform/catalog`. Replace the single eager registry export with the
target starter's pack declaration, `catalogueConformance` export and lazy
registry block. Have the fixture pack use your retained `types` array. Move
any still-used drafts into their pack entries and keep their type references.
Run the source check and start the demo. Archive the retained JSON after
verifying the conversion.

Upgrade replaces a pristine `package.json` and removes the old
`catalogue:check` script. For a customized manifest, use the upgrade-conflict
workflow to reconcile the manifest, then switch local and CI calls to the
`catalogue:check:source` npm script.

Demo installation now uses each non-starter entry in declaration order. Use an
application-owned ID and namespace, update references together, and supply and
test `owned/catalogue-rules.cjs`. Give intentional changes to immutable pack,
type or profile definitions new versions. Run the source check, then run
`./lifecycle up` to rebuild the image and activate demo definition installation.
Applying application files alone performs no catalogue installation. See the
Platform release notes under “Handle typed catalogue definition install refusals”
for the experimental install and binding error changes.

- The starter publication guide shows where Prepare reports missing or ineffective price lists and how to correct the affected draft operation before publishing.

### Publish saved catalogue drafts in the starter

The demonstration installer provisions the restricted publication connection on
`./lifecycle up`. Use the installed starter guide to approve, publish, recover
a receipt and read exact catalogue facts. The extracted `AGENTS.md` points to
this workflow. Use the target extraction for a pristine guide or copy the new
catalogue pointer into a customized guide. If startup reports
`starter_catalogue_publication_password_missing` or
`starter_catalogue_publication_login_invalid`, rerun the demonstration installer
and verify its private credential is mounted before serving the application.

### Keep fresh governed purchases unavailable in the starter

Install the complete native catalogue before starting the updated host. A
pristine extraction includes the updated checkout and recovery bindings. In
a customized extraction, preserve local policy and apply the host binding
changes together. Checkout authenticates the original request before reusing a
draft. Recovery verifies the original lineage, draft receipt and payment
receipt before offering a replacement. An eligible tokenless legacy checkout
can still be recreated.

The experimental catalogue acceptance type can carry private owner evidence.
Historical acceptance without that evidence remains readable.

### Change a live base price in the demonstration starter

After Activation, an active administrator can edit `basePrices` in
`owned/catalogue.ts` and run the starter's `catalogue:apply` script with
`--reprice`.
Approval covers gross base amounts. Each receipt reports the effective
subscription figure and policy revision after the write. Default apply verifies
the publication receipts and live prices after Activation.

Upgrade replaces the pristine managed lifecycle, refusal and operator files
together. If upgrade reports a conflict, save your changes, restore the
predecessor files, apply the upgrade and reconcile your changes with the updated
files before startup. If a starter command refuses after applying only some
managed changes, compare the managed files with the target upgrade and complete
the upgrade before retrying. Keep declarations in `owned/catalogue.ts`.
The upgrade requires no price write or installed policy step.

### The starter's checkout transport and bookkeeping move to `shared/`

The neutral starter gains `shared/storefront-bindings.ts`, which binds
`createPurchaseContinuation` from `@openlup/platform/storefront` to the
starter's checkout actions. It keeps the existing tab record
(`neutral-store:checkout-continuation:v1:<configuration>`), uses the stored
continuation value as the `checkout.create` key, and classifies the starter's
answers. A record written by an earlier starter page is reused: call
`adoptFingerprint` before the first submit and the purchase continues under
the same key. The action transport `act` and `uncertainAction` move from
`client/api.ts` to `shared/transport.ts`; `client/api.ts` re-exports both, and
`act` takes an optional request deadline. The checkout page's create
bookkeeping moves into the new module. A store-owned client can import both
modules instead of rewriting the wire. The bindings send a create only after
its dispatch time reads back from the record, and their finality rule assumes
per-tab storage (`sessionStorage`) and the shared `act`'s request timeout.

The managed pages are unchanged, with one correction: "no order under this
key" now counts as final strictly after the request timeout plus the late-create
bound, 1 ms later than before, matching the host's own strict stale rule.
Behaviour is otherwise unchanged.

Migration: Upgrade replaces pristine copies of `client/api.ts`,
`client/purchase.ts` and `test/checkout-continuation.test.ts`, and adds
`shared/transport.ts`, `shared/storefront-bindings.ts` and
`test/storefront-bindings.test.ts`. If apply reports that a managed file has
local edits, keep your edits separately, restore the file from the installed
starter version, rerun apply and reconcile your edits with the replacement. A
customised `client/api.ts` that still defines `act` itself keeps working. This
upgrade requires no installed-policy step.

### The starter checkout page keeps one checkout key per purchase

The neutral starter's managed checkout page now keeps one `checkout.create`
key for each purchase in the browser tab. It stores the key in tab storage
under `neutral-store:checkout-continuation:v1:<configuration>` before the first
request leaves the browser. After a lost response, a reload or a retry
continues the same order instead of creating a second order and a second stock
hold. The page starts a new key only after the host confirmed that the earlier
order is closed, or that no order exists and none can still arrive. "No order"
counts as final only 15 seconds after the last create settled; when the browser
lost that create in transport, only 35 seconds after it was sent. For a record
from an earlier page load, it counts as final no earlier than 15 seconds after
the reload and 35 seconds after the create was sent. A refusal that wrote
nothing keeps the key, and the panel does not appear on load after it.

Changed details, or a later purchase in the same tab while an unpaid order
exists, answer `starter_checkout_changed` and open a panel. The panel also
appears on load when the tab holds an earlier order or an uncertain create. It
offers "Complete payment for the earlier order", which shows the order's total
and then its payment link. It also offers "Cancel the earlier order and start
over", which cancels the unpaid order and releases its stock. After
`starter_checkout_not_abandonable` or `starter_checkout_expired` it also offers
"Start a different purchase". That choice leaves the earlier order open until
the store settles it; a payment already started for it may still complete. The
checkout form no longer has the "Start a new action" button; other forms keep
it. The completion page ends the key when it shows the order under it as paid,
cancelled or expired.

A browser that blocks tab storage sees `starter_storage_unavailable`. Its form
keeps the key in the page across retries and refused totals, until a reload or
changed details, or the buyer chooses "Start a new action". The page raises `starter_checkout_session_changed` when an
answer belongs to another sign-in state: sign in or out as when the order was
placed. If the host answered with an order of the current sign-in state, the
page also shows that order, and says when it was cancelled. It raises
`starter_checkout_in_progress` when an earlier create may still be running. An
order cancelled from the panel carries `checkout_started_over`.

Apply the application file upgrade to replace pristine managed files:
`client/forms.ts`, `client/purchase.ts`, `client/pages/checkout.ts`,
`client/quote-acceptance.ts`, `client/api.ts`, `shared/api.ts` and
`shared/limits.ts`. If it reports a
conflict, reconcile your customised files with the target starter. The buyer
texts of the panel and its answers are the managed `checkoutContinuationCopy`
export in `shared/limits.ts`; re-apply any customised text after the upgrade.

If your store owns its checkout page, follow the guide's rules: one random
version 4 key per purchase, stored before the first request; a new key only
after a confirmed end, never after a transport error; "no order" final only
after your request timeout plus 15 seconds; and the key treated as a
credential, never logged or reused. Changed details under the key answer
`starter_checkout_changed`, so the page need not compare details itself.

### The starter's checkout page runs on the purchase-continuation controller

The managed checkout page takes its key, replay, resume and start-over from
`createPurchaseContinuation` through `shared/storefront-bindings.ts`. Three
buyer-facing changes: changed details while an earlier order may exist send
nothing, and the page shows `starter_checkout_changed` itself; a create whose
answer was lost is repeated once under the same key; the payment-status page
keeps the record of an expired order. "Start a different purchase" is offered
whenever an answer names the earlier order as not payable, or a refusal leaves
an order possible. After a refusal that wrote no order, such as
`starter_checkout_request_stale`, corrected details are still sent.

Migration: Upgrade adds
`examples/neutral-store/browser/checkout-controller.spec.ts` and replaces
pristine copies of `examples/neutral-store/client/forms.ts`,
`examples/neutral-store/client/purchase.ts`,
`examples/neutral-store/client/pages/checkout.ts`,
`examples/neutral-store/shared/limits.ts`,
`examples/neutral-store/shared/storefront-bindings.ts`,
`examples/neutral-store/test/checkout-continuation.test.ts`,
`examples/neutral-store/test/checkout-anchors.test.ts`,
`examples/neutral-store/test/storefront-bindings.test.ts`,
`examples/neutral-store/browser/journey.spec.ts`,
`examples/neutral-store/browser/lost-response.spec.ts`,
`examples/neutral-store/browser/checkout-expected-total.spec.ts`,
`examples/neutral-store/browser/storefront-anchors.spec.ts`,
`examples/neutral-store/playwright.config.ts`,
`examples/neutral-store/playwright.database.config.ts`,
`examples/neutral-store/ownership.json`,
`examples/neutral-store/README.md` and
`examples/neutral-store/docs/ownership.md`. A customised copy of
`examples/neutral-store/test/checkout-continuation.test.ts` conflicts and is
reconciled. Owned page copies keep working. No installed-policy step.

- Copied starter checkout pages must send the reviewed `expectedTotal` amount
  and currency on every fresh submit in either purchase mode. Keep the exact
  payload and command key when retrying an uncertain response. On a definitive
  `starter_expected_total_required` or `starter_quote_price_changed` refusal,
  clear consent and fetch a new `offer.validate` review. Keep the key: the
  refusal created no order, and a reconfirmed create under the same key cannot
  create a second one. A page that retires the key after such a refusal accepts
  that an earlier create still in flight under the old key can place a second
  order. Managed checkout pages handle these steps.

### One checkout key addresses one starter order

In the neutral starter's host, a repeat of `checkout.create` with the same
`Idempotency-Key` and the same details returns the first order. While it is
unpaid, the repeat also returns a further continuation `token`, so a guest can
pay after a lost response. Earlier tokens stay valid and a repeat sends no mail.
A refreshed quote acceptance for the same stored terms is the same purchase.
Under a version 4 UUID key, changed details answer `starter_checkout_changed`,
`starter_checkout_paid` or `starter_checkout_not_payable` instead of
`starter_command_conflict`, and are never applied. Other key formats keep
`starter_command_conflict`. Under a version 4 key, a create whose draft receipt
was invalidated now answers `starter_checkout_not_payable` instead of
`commerce_order_draft_expired`.

The new `checkout.continuation` operation resumes or abandons the order under
a version 4 UUID key without its details, adding one starter operation. An abandoned order carries the reason `checkout_started_over`. An
order whose creation has not completed can be abandoned only once it is a
minute old; before that the answer is `starter_checkout_in_progress`. A
creation that is still running after that minute can leave a stray provisional
activation on the cancelled order, with no stock hold and no settlement intent,
so nothing is payable. A
fresh create that obtains its key lock more than 15 seconds after the host
received it answers `starter_checkout_request_stale` and writes nothing.

Each repeat and each continuation of a known key adds one attempt-ledger row.
It counts in a separate requester bucket and against `maxPerEmail` for that one
key, never against the buyer's email. A replaced quota callback receives these
calls with the idempotency key `<derived key>:replay:<uuid>` and the contact
`replay:<derived key>`, which is not an address. A fresh create now passes the
derived key, never the `Idempotency-Key` header value, as its idempotency key;
an attempt recorded before the upgrade is therefore counted once more if its
create is retried across the upgrade. A callback that throws refuses the
repeat, and the order is returned without a token. The host now stores the
derived key, `checkout:<64 hex>`, in `clients.metadata.checkout.lastIntentIdempotencyKey`.
`composeNativeBindings` accepts an optional `requesterKey` function that
replaces the socket-peer digest for every quota consumer. It must return a
lowercase 64-hex SHA-256 digest, or `undefined` when the requester is unknown.
A value that is not a function is refused at composition with
`OPENLUP_E_STARTER_REQUESTER_KEY_INVALID`. A returned value that is not such a
digest makes every request answer 503 `starter_dependency_unavailable`, and the
host logs that code to stderr.

Apply the application file upgrade to replace pristine managed files:
`host/purchase-composition.ts`, `host/checkout-attempts.ts`, `host/server.ts`,
`host/bindings.ts`, `host/native-composition.ts`, `host/quote-composition.ts`
and `shared/api.ts`. If it reports a conflict, reconcile your customised files
with the target starter before retrying. Apply the platform forward
`20261128230001_checkout_abandonment_safety_execute_grant.sql` before starting
the updated host: without it, `abandon` of an unpaid order answers
`starter_purchase_unavailable` and nothing is cancelled.

If you own your checkout client, your idempotency keys are now credentials for
unpaid guest orders: make them random version 4 UUIDs, never log them and never
reuse one for another operation. Keep one key for the whole purchase and treat
"no order under this key" as final only after your request timeout plus 15
seconds. A guest key does not survive sign-in or sign-out.

Guest orders created before the upgrade keep the raw key value in
`lastIntentIdempotencyKey` until a later checkout of that contact overwrites
it. Until those orders are paid or expire, that value could address them
through `checkout.continuation`. To remove it sooner, clear
`clients.metadata.checkout.lastIntentIdempotencyKey` for clients with unpaid
guest orders created before the upgrade.

### Authenticate the starter's runtime database login

The starter provisions an individual PostgreSQL runtime credential for each
Compose project. The runtime credential file must stay in owner-only
configuration. The starter validates it at start.

Migration: Stop the application, then run the updated `./lifecycle up` with the
existing Compose project, configuration, and listener port. [Starter guide](docs/guide/how-to/build/customize-the-starter.md#database-login)

- On marked starter demos, installation closes the exact obsolete subscription price rows and retains their history. Coffee and supplements keep their one-time bases and subscription amounts. One Light still quotes 4,200 XTS minor units. A one-time bundle gives 5% off at 12,000 minor units or more. Three Light go from 12,600 to 11,970 and one Dawn with two Noon goes from 12,900 to 12,255. The database-backed host runs the promotion claim sweep and watchdog in the background, with repair steps in the starter guide. On a fresh one-time checkout, the starter returns `starter_quote_price_changed` before creating an order if the submitted total differs from the server's re-quoted total.

### Native starter cancellation and save offers

The account offers direct cancellation and asks permission before showing an eligible save offer. Feedback is optional and follows committed cancellation. Omit `subscriptionCare.retention.offerPresentation` for ask-first behavior or set it to `off`. Direct cancel bypasses the legacy action lists and retains native payment and lifecycle fences. `defaultOffer` applies after Yes. The first admitted pause preset can replace the configured preselection.

Feedback transfers with the native full-store capture, and restores follow the [canonical `schema_conflict` remedy](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/migrations/compatible-data-transfer.md#compatible-data-transfer).

Migration: Apply the native Platform forwards before deploying the updated starter. Plan managed changes against both starter snapshots. Use candidate templates for untouched `owned/copy.ts` and `owned/settings-host.ts`. In customized versions, merge the seven permission and feedback strings in each active locale, remove `careGuidance` and `confirmCancel`, and update the retention and action descriptors while preserving local settings. If a managed account, host or shared file conflicts, reconcile the candidate logic into the local file and record its adopter ownership in both snapshots before retrying. Complete any interrupted apply with the same snapshots, then rerun to verify zero writes. Build and start the updated app and check the existing local markup and copy, the effective setting, direct cancel and optional feedback. A feedback setup refusal affects feedback alone. Preserve any intentional legacy `offerByReason` mapping; the startup validator refuses unsupported presentation modes.

### Keep default checkout attempt limits across starter restarts

Apply the checkout attempt ledger forward before upgrading application files or
starting the updated native starter. Use one PostgreSQL database per store and
the same limits in every process serving it. Older hosts can run with the
additive schema. The updated host starts counting in PostgreSQL without
importing old in-memory counters.

Apply the application file upgrade to replace pristine managed checkout hosts
and tests. If it reports a conflict, reconcile your customized checkout files
with the target starter before retrying. Keep custom quota callbacks and bind
the default callback to the held checkout session before the draft transaction.

In your owned settings host, update only the `purchase.attemptLimits` effect
description from the target starter and keep your bindings. In your owned copy,
apply the checkout quota wording in each locale and keep your other text.
If startup reports that the ledger is missing, apply the forward and restart.
If it reports missing EXECUTE, restore the runtime role's routine grant and
restart. For a failed readiness check, check connectivity and the runtime
credentials before restarting.

### Run the catalogue demonstration on a free local port

Export `OPENLUP_STARTER_PORT` before starting the demonstration and running
`catalogue:apply`. An unset or empty value uses 4319. Choose a decimal port
from 1024 to 65535. The default origin excludes ports blocked by Fetch. Startup
validates the port before Compose. Direct host startup accepts the full range.

The upgrade replaces pristine managed Compose, host, lifecycle and README files.
If upgrade refuses a locally edited managed file, save your edits and restore
the predecessor bytes before applying the upgrade. Move a local port edit to
`OPENLUP_STARTER_PORT` in your launch environment. Reconcile other edits with
the updated files before startup and keep unrelated owned overrides. If startup
refuses following an interrupted upgrade, complete the managed upgrade and use
the startup remedy before retrying. There is no installed business-policy step.

### Upgrade the starter catalogue document verifiers

The starter shares verification of the selected gram SKU across quote and
sized servicing. This upgrade prepares verification of mixed documents once
the installed reader can supply authenticated sibling evidence.

Upgrade replaces pristine copies of `host/editor-catalogue.ts`,
`host/editor-ports.ts` and `host/quote-composition.ts` together. If apply
reports a conflict, save the customized code, restore the predecessor files
and rerun apply. Reconcile the saved changes against the replacement group
before startup. A partial upgrade refuses startup with
`incomplete_application_upgrade`. This change requires no installed-policy
step.

### Find the invalid subscription offer member

`settings check` now reports the member and rule alongside
`starter_subscription_offer_invalid`. In
`subscriptionOffers.<mode>.days`, check `days` under `classic` or
`sized` in your owned store configuration. Correct the value and rerun
`settings check`.

Upgrade replaces a pristine `shared/subscription-offer.ts`. If apply
reports that the managed file has local edits, preserve those edits
separately, restore the file from the installed starter version, and rerun
apply. Reconcile your edits with the replacement before startup. This
upgrade requires no installed-policy step.

### Browse and quote published starter products

The native starter lists published SKUs, keeps exact sibling selections in
product URLs and checks SKU, quantity and currency in the server quote. Active
published products need a document schema distinct from the configured
application document schema and canonical draft JSON encoding.
The starter excludes SKUs without one-time sellability and reports
`starter_catalogue_one_time_required`. Enable one-time sellability through the
catalogue workflow to make the SKU eligible for listing.

Migration: Apply the managed starter upgrade. If you copied a storefront page
into application source, reconcile its SKU links, cart restoration and quote
checks with the candidate. Keep the existing owned card signature. For an
active schema collision, withdraw the colliding product through governed
catalogue commands and repeat the original quote.

- The neutral-store checkout keeps the reviewed acceptance and deadline across
  equivalent refreshes. Changes to the offer or an expired deadline require
  fresh review and consent.

### The starter cart opens with a selection from its address

The neutral starter's cart route now accepts a selection in its query string:
`line=<sku>:<quantity>` (repeated), `mode` (`one_time` or `subscription`) and
`cadence` (days, subscription only), for example
`/cart?mode=one_time&line=<sku>%3A2`. A buy link or a verification harness can
open checkout in a fresh browser without seeding browser storage. Build links
with `selectionEntryPath` from the new managed
`examples/neutral-store/shared/selection-entry.ts`.

- The cart validates the selection with `validateCart` against the storefront
  catalogue. It waits for the catalogue answer, and leaves the address unchanged
  when the catalogue answers with an error, the request fails or its answer
  cannot be applied.
- A valid selection replaces an empty cart. A cart that holds anything else
  shows a question, "Use the selection from the link" or "Keep my cart", and
  offers no other cart control or checkout until the buyer answers. The entry
  never merges lines.
- An invalid selection shows its own refusal with the cart's texts and writes
  nothing. It prints no raw link text: a SKU appears only when a product has it.
  A `+` is never valid in the address, encoded or not.
- Once decided, only `line`, `mode` and `cadence` leave the address, with one
  history replacement. Every other parameter stays with its bytes and has no
  effect; no price, amount or currency is ever read.
- The cart's checkout button carries
  `data-openlup-action="proceed_to_checkout"`, written from `storefrontAnchor`.
  The starter now imports that value from the experimental
  `@openlup/platform/storefront` entry.
- `PageContext` gains an optional `catalogueSettled` field, and `navigate`
  takes an optional `{ replace: true }` second argument.

A link over an emptied cart after an order was placed in the same tab cannot
create a second order: the next submit reuses the tab's checkout key and the
host refuses a changed payload under it with `starter_checkout_changed`,
`starter_checkout_paid` or `starter_checkout_not_payable`. That safety comes
from the host's refusal of a changed payload; a host that updated the order in
place would behave differently.

Migration: Upgrade adds `examples/neutral-store/shared/selection-entry.ts` and
`examples/neutral-store/test/selection-entry.test.ts`, and replaces pristine
copies of `examples/neutral-store/client/pages/storefront.ts`,
`examples/neutral-store/client/main.ts`,
`examples/neutral-store/client/context.ts`,
`examples/neutral-store/browser/journey.spec.ts`,
`examples/neutral-store/docs/customization.md` and
`examples/neutral-store/ownership.json`. If apply reports that a managed file
has local edits, keep your edits separately, restore the file from the
installed starter version, rerun apply and reconcile your edits with the
replacement. A store that owns its cart page or its `client/main.ts` keeps its
copy and gets neither the entry nor the anchor; to add them, import
`decideSelectionEntry`, `withoutSelectionEntry` and `settleCatalogueRequest`
from `shared/selection-entry.ts` in the application, and set
`catalogueSettled` from the catalogue request, or accept that the entry
validates before the catalogue answers. This upgrade requires no
installed-policy step.

### Declare 15 additional starter settings for discovery and check

`owned/settings-host.ts` now declares 15 existing starter configuration settings
(locale policy, guest contact defaults, return and hold reason subsets, checkout
initial payment window, recovery link policy, wave windows, subscription care
retention/actions/recovered window, renewal recovery and notice locales, sized
editing preferences, graduation cadence, and minimum product payable minor) with
Draft-7 Zod schemas and effect descriptions.

Upgrade replaces a pristine `owned/settings-host.ts`. For a customized copy,
merge the added declarations from the target starter. This change requires no
installed-policy step.

### Use the starter settings script to find and check configuration

The starter's agent guide shows how to find settings by goal, verify a value
edit and start the read-only settings server.

Migration: Before applying the next set's managed files, replace a pristine
`AGENTS.md` from the 1.3.0 starter with the target starter's `AGENTS.md`.
If the file has local edits, an explicit snapshot replacement refuses before
writing. Merge the target guidance into your copy, keep your edits and rerun
the managed upgrade without `AGENTS.md` in its snapshots. This documentation
change requires no installed-policy step and adds no startup refusal.

### Fix starter return reason, retry minimum and settings schemas

Starter store configurations now use `damaged` instead of `damaged_item` for
return requests so database return creation accepts every configured reason.
`renewal.retryBackoffHours` now requires positive whole hours (`>= 1`) matching
native SQL validation and documents the separate fixed 24/72/168-hour provider
failure ladder (`subscriptions.retrySchedule`). `subscriptionOffers.deliveryCycles`
and `purchase.attemptLimits` now expose strict Zod schemas and updated effect
guidance in `owned/settings-host.ts`.

Upgrade replaces a pristine `shared/renewal-config.ts`. For customized
`owned/store.config.ts` or `owned/settings-host.ts`, replace `damaged_item`
with `damaged` and ensure every retry backoff hour is at least `1`. This
change requires no installed-policy step.

### Move `shipping.rateResolver` to the packaged catalogue and report subscription policy file values

`shipping.rateResolver` is now a packaged `callback` entry in `@openlup/platform`
rather than a starter `code` declaration. `owned/settings-host.ts` removes its
local `shipping.rateResolver` descriptor and reports file values (without
descriptors) for `subscription_minimum_base_units` and
`subscription_sized_intro_phase`.

Upgrade replaces a pristine `owned/settings-host.ts`. For a customized copy,
remove any local `shipping.rateResolver` descriptor so `settings list` and
`settings check` do not refuse a duplicate packaged key. This change requires
no installed-policy step.

### The starter's checkout pages carry storefront anchors

The starter's checkout fields, submit and payment-status line carry
`storefrontAnchor` attributes. Behaviour and copy are unchanged.

Migration: Upgrade replaces pristine copies of
`examples/neutral-store/client/forms.ts` and
`examples/neutral-store/client/pages/checkout.ts`, and adds two tests. A
customised checkout page works without anchors. No installed-policy step.

### Declare seeded product physical facts

The starter takes a typed mass and a primary GTIN through its owned product
configuration. It retains the existing seed documents and identifiers when
the original physical facts are preserved.

Migration: For a pristine `owned/store.config.ts`, copy the candidate file.
For a customized file, convert each `physical` entry in place. Move the old
`netWeightG` to `netContent` with `dimension: 'mass'`, `unit: 'openlup:g'`,
`scale: 0` and the original whole grams as the decimal string `unscaled`.
Move `issuer` and `unitGtin` into `primaryUnitIdentifier` as `issuer` and
`value`, with `scheme: 'gs1:gtin'`. Keep all the original GTIN digits and the
issuer for all six demonstration entries, or carry over each corresponding
custom value. Preserve unrelated owned edits and apply the managed upgrade.
Restart and recheck `/api/config`. An unchanged seed replay requires no
installed-policy step.

If startup reports `OPENLUP_E_STARTER_PRODUCT_PHYSICAL_INVALID`, correct the
named entry from verified facts. If an issuer correction changes its retained
digest, follow “Reset an interrupted first install” for an owner-approved
rebuild of the disposable demonstration in the same Compose project.
That procedure removes all data in the demo volume. If startup reports
`OPENLUP_E_STARTER_SYNTHETIC_PHYSICAL_SIZE_INVALID`, correct the named SKU's
numeric `physicalSize` in `owned/subscription-editing.ts` to a verified whole
gram value from 1 through 2147483647. Restart and recheck `/api/config`.

## [1.3.0]

- Publishable on the npm `latest` dist-tag as `1.3.0`, from tag
  `openlup-core-v1.3.0`.

### Compatibility exception

This minor release tightens native payment settlement outside the SemVer promise.

- (a) Contract: success results of custom payment reconciliation readbacks, native renewal bindings and native webhook adapters. Action: return the provider-collected amount and currency (`amountMinor` and `currency` in readbacks, `observedMoney` in renewals) with `capturedAmountBasis: "provider_capture_v1"`; on webhook evidence, keep the basis outside the event fingerprint.
  Behaviour is specified by “records the exact amount and provenance of a %s readback before settling” and “makes replay fingerprints independent of receipt time and never invents provider occurrence time”.
- (b) Contract: amount selection in `@openlup/platform/payments/stripe` and `@openlup/platform/payments/tpay`. Action: before settling, retrying or invoicing, review readbacks flagged `provider_amount_mismatch` and webhooks answered with HTTP 409 and reason `provider_amount_mismatch`.
  Behaviour is specified by “keeps a provider success with zero collected money out of capture readback”, “records a provider success with conflicting %s without settling native payment”, “records and refuses a signed success with conflicting collected amount %s on each delivery” and “acknowledges a completed legacy receipt for $object”.
- (c) Contract: replay of completed 1.2.0 native reconciliations. Action: replay with the original key and evidence.
  Behaviour is specified by “records the exact amount and provenance of a %s readback before settling”.
- (d) Contract: native late captures on a cancelled intent or a cancelled or expired order. Action: find them with `captureReviewRequired` or `readCaptureReview`, and resolve the transaction with the provider before charging again.
  Behaviour is specified by “retains a %s order's late %s capture without paying it”.

If your legacy cart reminder job runs under its own database role, run this
grant as the database owner once after applying the reminder episode pin
migration. Replace `cart_runtime` with the role that runs the job.

```sql
GRANT EXECUTE ON FUNCTION public.commerce_enqueue_abandoned_cart_reminder_episodes(integer) TO cart_runtime;
```

The job reports `checkout_recovery_cart_runtime_grant_required` and supplies
the command for its role if the grant is missing. The built-in runtime role
already has the grant.

Apply the checkout recovery reminder guard and episode pin migrations before
using the target installer. Pinned episodes keep their timing and are exempt
from the schedule-change guard. An older pending checkout order with a wave
and no pin blocks a change regardless of age with
`checkout_recovery_schedule_change_blocked_open_episodes`.
The same refusal applies to an unpinned pending abandoned cart with a wave, a
valid draft receipt and no settlement intent. Keep the current schedule until
the blocking orders close or their carts stop qualifying.

Changed installs and reminder producers at `REPEATABLE READ` or `SERIALIZABLE`
refuse with `checkout_recovery_schedule_isolation_unsupported`. With an installed
schedule, a compacted checkout wave consumes both stages and the later stage
is skipped. With no schedule installed, historical hours identify its stage.

### Fixed

- Rank installed reader-guide recipes and upgrade narrative sections above generated `### \`packages/*/api/*.api.md\`` diff blocks in `openlup-context search`, cap repeated API-report diff matches to one per upgrade file unless `.api.md` is queried explicitly, match `PascalCase` and `UPPER_SNAKE_CASE` declaration symbols in multi-word queries, and raise the per-package declaration and source scan limit from 1,200 to 2,000 files.

Migration: This search-ranking change does not alter result shapes, CLI flags, package runtime or SQL. The declaration and source scans report `scans[].fileLimit` of `2000`.

- Improve `openlup-context search` to resolve exact exported symbols directly to their declared public package subpath via installed `package.json#exports` declaration entrypoints while keeping non-entrypoint declaration occurrences clearly marked unverified.
- Scope `@openlup/core` `.api.md` declaration snapshots to each subpath's own directory and explicit re-exports without changing any exported runtime or type symbol.

Migration: No application changes required. Snapshot scoping does not alter public exports. It removes cross-subpath duplicates from generated `.api.md` snapshots.

- Add machine-readable `FULFILLMENT_STATUS_EFFECTS` and `FulfillmentStatusEffect` to `@openlup/core/fulfillment` alongside the unchanged `FULFILLMENT_STATUS_MAP`, exposing domain stock, handover, notification, tracking, and off-track flags without UI prose or locale keys.

- Improve `openlup-context` search ergonomics and determinism:
  - Traverse declaration, application, and package-source directories in deterministic lexicographic order so bounded scans produce identical results across filesystems.
  - Add configurable result limits (`1..50`, default `8`) via `--limit <n>` / `--limit=<n>` on the CLI, `limit` on the MCP `search_openlup_context` tool, and an optional `SearchContextOptions` argument on `searchContext(...)`.

### Discover and check the starter's owned settings

Update the installed OpenLup packages together. Include the target's
`owned/settings-host.ts` as a creation in the upgrade snapshot if that path
is absent. If the file exists, preserve it and merge the following additions by hand.

Ensure the upgraded application manifest declares `"zod": "4.6.6"` in
dependencies and update its lockfile. In `owned/settings-host.ts`, add the Zod
import after the `pg` type import, extend the settings type import, annotate
`entries`, and replace the existing filter as follows:

```diff
 import type { Pool } from 'pg';
+import { z } from 'zod';
-import type { SettingsAppBindings } from '@openlup/platform/operations/server';
+import type { SettingsAppBindings, SettingsFileEntry } from '@openlup/platform/operations/server';
-  const entries = {
+  const entries: Record<string, SettingsFileEntry> = {
-      entries: Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.value !== undefined)),
+      entries: Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.descriptor !== undefined || entry.value !== undefined)),
```

Copy the six `descriptor` members with their native Zod schemas from the target
starter's `file.entries` into the existing entries for
`offer.freeShippingFromMinor`, `offer.subscriptionDiscountBps`,
`purchase.reservationMinutes`, `subscriptionCreation.editWindowHours`,
`subscriptionOffers.deliveryCycles` and `subscriptions.lifecycleNoticeRetryBudget`.
Keep your value expressions, file locations and app-specific entries.
The filter keeps declarations with missing values and omits undefined
value-only reports.
If your binding has no `file` member yet, merge the target's
`file: { configuration, entries, validate }` section using your selected
configuration and existing startup assertion. Keep the installed policy
entries value-only and preserve your connected readers and stock source.

From the app root, pass these arguments to the settings script in `AGENTS.md`:

- `list --goal "free shipping"`
- `show offer.freeShippingFromMinor --json`
- `check --json`

Confirm that the list includes the key, show reports the expected file value and
check includes the six declarations. For a value reported without a descriptor,
add the matching descriptor as above and rerun. These reads require no database
connection.

### Discover and preview settings with the package command

- Use the settings script from the extracted application root as shown in its `AGENTS.md`.
  The settings script calls the installed experimental `openlup settings`
  command. `show` and `explain` work offline. To preview, pass the proposal with
  `--value <json>` or `--value -` for stdin.
- Upgrade the managed `package.json` and `ownership.json` to the target
  extraction. Include `owned/settings-host.ts` as a creation in the target
  snapshot only if that file is absent in the application. Keep an existing
  owned file and its local bindings. Append the **Change a business setting**
  section from the target's `AGENTS.md` to the application's guide when absent.
- If the upgrade refuses because the planned host path became occupied, keep the
  local file and remove its creation from the target snapshot. Replan and apply
  the reconciled snapshots, then replay. The installed application upgrades with
  its local host bindings intact.
- After applying the snapshot, update the installed dependencies to match the
  target extraction. Use the settings script with
  `show checkout_recovery_reminders --database-url <read-capable-url> --json`
  against the intended store to verify the command and the owned binding: this
  key is read through the reader that `owned/settings-host.ts` supplies. A
  missing or unloadable binding module returns `commerce_setting_read_unavailable`
  with exit 74. A module that loads without that reader returns the same code
  with exit 1 and the hint that no connected reader exists for this key. Stock or
  reminder policy installation remains a separate deployment step.

### Use the installed renewal horizon in the starter editor

Take the target extraction's `host/editor-ports.ts` through the managed upgrade
plan and apply. If local edits cause a conflict, move them to an application-owned
file outside both snapshots and restore the exact predecessor bytes in
`host/editor-ports.ts`. Replan and apply with the same snapshots. Keep the app
stopped until the managed snapshot and installed OpenLup versions match.

The running editor reads the installed horizon on its next stock read. This
upgrade needs no separate policy write or runtime privilege.

### Preview renewal stock protection before deploying

- The settings host supplies the stock source for the selected owned
  configuration. Pass `preview --help` to the settings script to see
  the connected syntax. Preview requires a read-capable PostgreSQL connection.

### Starter catalogue unit factor

- For a pristine starter, take the target extraction's `owned/catalogue.ts`.
  It declares one `openlup:piece` per `starter:each`.
- For a customized starter, add the exact factors from `owned/catalogue.json`
  to the corresponding count units in `owned/catalogue.ts`. For a unit that
  represents one piece, use `{ canonicalUnit: 'openlup:piece', unscaled: '1', scale: 0 }`.

No database step is required.

### Show database hints during starter installation

Take the target extraction's `lifecycle.mjs` through the managed upgrade plan
and apply. If local edits cause a conflict, move the local launch behavior to
an application-owned launcher outside both snapshots that delegates to
`lifecycle.mjs`. Restore the exact predecessor bytes in `lifecycle.mjs`, then
replan and apply with the same snapshots. Keep the app stopped until the
managed snapshot and installed OpenLup versions match.

When the schedule guard refuses installation, the starter prints the existing
message first and the retry hint on the next stderr line. Other installer
errors with a database hint use the same format. Installation retains the same
exit status and refusal codes. This file upgrade requires no additional
settings write or database grant.

### Starter paid receipts and account dates

A pristine upgrade replaces the managed `host/paid-mail.ts`,
`client/pages/account.ts` and `browser/acquisition.spec.ts` with the target
extraction's files. Paid receipts use the order currency's minor-unit exponent.
The account page shows the next cycle date in the market time zone.

If apply refuses because one of those files has local edits, move the edits to
application-owned files, keeping any imports they need. Restore the pristine
predecessor at each modified managed path, then apply again. Apply installs
the target managed files and replay preserves the application-owned files.

### Starter catalogue rules

Keep your existing `owned/catalogue.ts` validator when you upgrade. The
upgrade leaves the new rules bundle and test absent. To switch to installed
rules, copy `owned/catalogue-rules.cjs` and `owned/catalogue-rules.test.cjs`
from a fresh extraction of the target starter and move your content checks
to the bundle's `validateContent`. Run `node --test owned/catalogue-rules.test.cjs`,
then `./lifecycle up` to use those rules in the operator form.

- Clarify in the starter ownership guide which extraction modes commit the installation lockfile and which local address callback results the platform accepts.

### Starter installation test

Use the target extraction's managed `test/installation.test.ts` when the
predecessor file is pristine. The test checks one idempotent write per setting
with the configured value inside a single install transaction.

For a customized test, move independent local test cases and their imports to
an application-owned test file. Restore the pristine predecessor at the managed
path, then apply the upgrade. Apply and replay keep the local file and use the
exact target bytes for the managed test. Startup refusals retain their existing
behavior.

### Find more starter settings by goal

New neutral-store extractions declare payment retry timing, checkout limits,
shipping and tax, subscription care, the displayed returns period, price
rounding, and market settings in `owned/settings-host.ts`. Use the app's
settings script with `list --goal "payment retry"` or `list --goal "flat shipping"`
to find the owned file to edit, then run `check --json` for the selected
configuration.

An upgrade preserves an existing `owned/settings-host.ts`. To add these
settings to an existing app's search, copy the new declarations from the target
starter into your binding and keep your app's values, locations and custom
entries. This step is optional. Existing bindings and app behavior continue to
work without it. The upgrade requires no installed-policy step. If the settings
check refuses after reconciliation, correct the named declaration or startup
validation error and rerun it.

## [1.2.0]

- Publishable on the npm `latest` dist-tag as `1.2.0`, from tag
  `openlup-core-v1.2.0`.

### Changed

- Document the source starter's owned language registry, configured default and named startup copy refusals. The current platform language set remains `en` and `pl`.

Migration: Existing source-starter adopters add `market.defaultLocale` and compose the owned `market` registry from `owned/market.config.ts`. Keep `locales: ['en', 'pl']` and `defaultLocale: 'en'` for the previous demonstration behavior. This documentation change adds no npm API or SQL migration.

### Starter applications from 1.1.0

Migration: Before applying this set's managed starter files, reconcile the
owned files below against a separate target extraction. Keep immutable managed
snapshots from both extractions. Add `owned/market.config.ts` **only to the
target snapshot**, using that extraction's exact bytes; it is a new owned file,
not a newly managed customization. The upgrade CLI then creates it with the
usual conflict refusal, interruption recovery and replay behavior. Leave every
other owned path out of both snapshots. After creation, keep the market file
application-owned and outside future managed snapshots.

For each uncustomized file in this table, take the target extraction's bytes
before applying managed files. For customized files, preserve local values and
apply the reconciliation described below. Do not overwrite a customized file
with the demonstration defaults.

| Owned path | Reconciliation |
| --- | --- |
| `AGENTS.md` | Merge the target's task routes, representation bounds and explicit inventory-policy installation guidance into local contributor instructions. |
| `owned/renewal.config.ts` | Add account actions and pause choices; use the configured default locale for notices. |
| `owned/store.config.ts` | Add subscription creation, the installed inventory policy and the checkout recovery reminder schedule to every configuration. Compose the locale registry. |
| `owned/acquisition-policy.ts` | Optionally adopt the local address callbacks; the existing callback-free policy remains valid. |
| `owned/copy.ts` | Keep all required application copy keys for each configured locale. |
| `owned/editor-copy.ts` | Keep all editor keys for each configured locale. |
| `owned/quote-copy.ts` | Keep quote and refusal keys for each configured locale and the explicit refusal allowlist. |
| `owned/renewal-copy.ts` | Keep all renewal notice keys, including nested paid-order text, for each configured locale. |
| `owned/demo-seed.ts` | Read product name and description with `config.market.defaultLocale` instead of `.en`. |

`AGENTS.md` is extracted from the source template. Its guidance changes have no
startup refusal of their own; preserve local authority and contribution rules
when reconciling it with the target.

#### Account actions and pause choices

In `demoSubscriptionCare()` in `owned/renewal.config.ts`, add
`subscriptionCare.actions` with all five keys. The target defaults are:

```text
actions: {
  active: ['skip', 'slide', 'order_now', 'pause', 'cancel'],
  paused: ['resume', 'cancel'],
  cancelled: ['reactivate'],
  whilePaymentBlocked: ['pause', 'cancel'],
  whilePaymentExpired: ['cancel', 'resume'],
}
```

Each value is an array without duplicates, containing only `skip`, `slide`,
`order_now`, `pause`, `cancel`, `resume` or `reactivate`; empty arrays disable
actions. Missing keys, unknown keys or invalid arrays refuse startup with
`starter_subscription_actions_invalid`. State admission applies to all actions.
The payment-state allowlists apply to actions other than `reactivate`.
To disable reactivation, remove `reactivate` from `actions.cancelled`.
Native command guards still apply.

Add `subscriptionCare.pausePresets` with
`{ allowed: ['2_weeks', '1_month', 'indefinite'], default: '2_weeks' }`.
The equivalent target helper is `choice('2_weeks', '2_weeks', '1_month', 'indefinite')`
from `shared/policy.ts`. The allowed array must be nonempty, unique and limited
to those three values, and must contain the default. Missing or invalid choices
refuse with `starter_pause_presets_invalid`.

The target also adds `subscriptionCare.retention.pausePreset: '1_month'`.
This member is optional: omission uses `pausePresets.default`. If present, it
must be one of the allowed presets or startup refuses with
`starter_retention_configuration_invalid`. Preserve the existing retention
reason mapping, local timing and three-rung retry ladder.

#### Subscription creation and representation bounds

In every configuration in `owned/store.config.ts`, add
`subscriptionCreation: { editWindowHours: 72 }`, or retain a deliberate local
whole-hour value from 1 through 720. Missing, fractional or out-of-range values
refuse startup with `starter_subscription_creation_invalid`. This is the
initial subscription snapshot's edit window; it does not rewrite existing
subscriptions or replace the separate editing policy.

No owned edit is needed for the target's existing representation defaults.
Check customized offers: `offer.maxUnits` is at most 100, each per-SKU
subscription quantity domain has maximum 99, and
`maximumBaseLines + maximumAddonLines` is at most 50. Violations refuse startup
with `starter_units_above_representation` or
`starter_lines_above_representation`, respectively. The target keeps
`maximumBaseLines: 6`, `maximumAddonLines: 12` and per-SKU quantities 1 through
99; the total `maximumUnits: 1782` is a separate commercial bound.

#### Install the renewal stock policy explicitly

In every configuration in `owned/store.config.ts`, add
`inventory: { renewalProtection: { revision: 'starter-1', renewalProtectionDays: 14 } }`.
A customized policy has exactly `revision` and `renewalProtectionDays`: a
nonblank revision and an integer day count from 1 through 3660. Missing or
invalid policy refuses startup with
`inventory_renewal_protection_policy_invalid`.

Apply the selected platform package's complete native catalogue, including
`20261123130000_inventory_renewal_protection_policy.sql`, using the database
migration procedure in this guide. Then, with a dedicated
write-capable installation connection, explicitly call
`installRenewalStockProtectionPolicy(connection, config.inventory.renewalProtection)`
from `@openlup/platform/inventory` for the configuration being installed.
Read it back with `readRenewalStockProtectionPolicy(connection)` and confirm
both revision and day count before restarting. In the disposable demonstration,
the explicit `./lifecycle up` installation step calls this installer before
the HTTP host starts; application startup itself only reads the installed
policy. Never use the demonstration seed to migrate a customer database.

An absent key reads as `{ revision: 'default', renewalProtectionDays: 14 }`;
even though the days match, it differs from `starter-1`. Startup refuses
`starter_installed_policy_drift` whenever either installed field differs from
the owned policy. Editing a file or applying file snapshots installs no policy.
For later changes, deliberately install the selected revision and days again
with installation authority, verify the readback, then restart.

#### Install the checkout recovery reminder schedule explicitly

In every configuration in a customized `owned/store.config.ts`, preserve local
values and add `checkoutRecoveryReminders` with exactly `revision`,
`abandonedCart` and `checkoutRecovery`. The target uses the historical waves.

```text
checkoutRecoveryReminders: {
  revision: 'starter-1',
  abandonedCart: [
    { stage: 'first', afterHours: 1 },
    { stage: 'gentle', afterHours: 24 },
    { stage: 'last', afterHours: 72 },
  ],
  checkoutRecovery: [
    { stage: 'first', afterHours: 1 },
    { stage: 'last', afterHours: 20 },
  ],
}
```

Use a nonblank revision and a nonempty array for each reminder kind. Each wave
has exactly `stage` and `afterHours`. Use strictly increasing integer hours
from 1 through 2147483647, with unique stages and `last` as the final stage in
each array. `abandonedCart` allows `first`, `gentle` and `last`.
`checkoutRecovery` allows `first` and `last`. Startup and installation refuse
a missing or invalid schedule with `checkout_recovery_reminder_schedule_invalid`.

Apply the target platform package's complete native catalogue, including
`20261123140000_checkout_recovery_reminder_schedule.sql`. Then run the
explicit installation step for the selected configuration. On a dedicated
write-capable installation connection, call
`installCheckoutRecoveryReminderSchedule(connection, config.checkoutRecoveryReminders)`
from `@openlup/platform/commerce/server`. Use
`readCheckoutRecoveryReminderSchedule(connection)` to confirm the revision and
both wave arrays before restarting. In the disposable demonstration,
`./lifecycle up` runs the installer before starting the HTTP host.

Database-backed startup reads the installed schedule and refuses with
`starter_installed_policy_drift` if the revision, stages or hours differ from
the owned configuration. An absent setting uses revision `default`, which
differs from `starter-1` even when the waves match. The managed
`host/paid-mail.ts` selects the recovery subject by stage and retains the
hour-based rule for legacy payloads that have no stage.

#### Locale registry and copy

The new `owned/market.config.ts` exports `market` with
`locales: ['en', 'pl']` and `defaultLocale: 'en'`. After its target-only creation,
a customized application may choose a nonempty unique subset of `en` and `pl`;
the default must be in that subset. Empty or duplicate locales refuse startup
with `starter_locales_invalid`, unsupported languages with
`starter_locale_unsupported`, and a missing or unconfigured default with
`starter_default_locale_invalid`.
Omitting the new file prevents module loading with `ERR_MODULE_NOT_FOUND`.

Import the owned `market` registry into `owned/store.config.ts` and
spread it into every `market` object, preserving local country, currency and
timezone. The target `owned/renewal.config.ts` sets `notices.locale` to
`market.defaultLocale`. A pristine file takes that change; a customized notice
locale may stay when it is in `market.locales`, otherwise notices fall back to
`market.defaultLocale`. Startup refuses unsupported notice locales or country keys
other than two uppercase letters with `starter_renewal_configuration_invalid`.
A country mapping to a platform-supported locale outside `market.locales`
passes startup validation. Notice delivery falls back to `market.defaultLocale`.
For example, mapping a country to `pl` in an English-only registry delivers notices
in English. Keep mappings within `market.locales` by removing or remapping
entries for dropped locales.

Change the two product text reads in
`owned/demo-seed.ts` to `name[config.market.defaultLocale]` and
`description[config.market.defaultLocale]`.

Preserve customized translations in the four copy files above. The target uses
`LocaleCopy` from `shared/locales.ts`; copy, editor and quote key types come
from `shared/copy-keys.ts`, and `RenewalNoticeText` comes from
`shared/renewal-config.ts`. Adopt those typed forms when adapting registries;
keep `CopyKey` exported from `owned/copy.ts` and use `quoteRefusalKeys` for
`isQuoteRefusalCode`, as in the target, so the refusal allowlist is independent
of a translation. Every configured locale must have nonblank strings for the
complete key inventory, including `renewalNoticeCopy`'s `paid` members. Extra
inactive translations may remain. The managed locale test checks coverage and
startup validation and accepts customized wording.

The same requirement applies to localized brand, store, media, product,
recovery message, return/hold choice and acquisition-address labels in owned
data, including `owned/catalogue.ts`, `owned/subscription-editing.ts` and
`owned/acquisition-addresses.ts`, even though those files need no default edit.
Missing or blank text refuses with `starter_locale_copy_missing`, naming its
path and locale. Malformed recovery state/message inventories still refuse
with `starter_recovery_configuration_invalid`.

#### Optional local address callbacks

The target's `savedAddressValidation()` in `owned/acquisition-policy.ts` adds
`local.normalizePostalCode`, `local.isValidPostalCode` and `local.normalizePhone`.
Its fictional defaults remove postal whitespace, accept two uppercase letters
and four digits, and normalize eight local phone digits to `+999` (also
accepting that prefixed form after removing whitespace, parentheses, plus and
hyphens). A customized policy may omit `local` to keep the existing fallback;
there is no new required owned member. If provided, all three callbacks must
be functions or construction refuses with `saved_address_policy_invalid`.
Use the application's own country formats. These callbacks run only when the
selected country resolves to the policy's configured country, including aliases.
Normalization can run more than once per parse. Keep the callbacks deterministic
and effect-free, without I/O, authorization checks or reads of mutable state.
The platform trims and collapses input whitespace and uppercases postal input
before normalization. Postal input and output are bounded to 24 characters and
phone input and local output to 64. Postal normalization must return a
nonempty string and `isValidPostalCode` must return literal `true` to accept;
any other result refuses the field. Return `null` to refuse a supplied phone.
A callback throw refuses the affected field with its configured policy message.

#### Managed tests that pin demonstration values

`test/e4-oms.test.ts` expects the demonstration postal and phone formats.
`test/renewal.test.ts` expects the demonstration account action lists, allowed
pause presets and both pause defaults. `test/address-outcomes.test.ts` matches
the demonstration wording for a change that applies from the next parcel.
`test/acquisition-quote.test.ts` requires the translations of three price
refusal codes to exceed 20 characters, although startup accepts any nonblank
translation. `browser/acquisition.spec.ts` ages a checkout by 21 hours and
expects two recovery reminder emails; a customized reminder schedule needs its
timing fixture and expected reminder count adapted.
`browser/acquisition.spec.ts` also uses the demonstration saved-address formats,
account actions and pause defaults. The browser specs (`browser/*.spec.ts`,
including `editor-components.spec.ts`, `e4.spec.ts`, `journey.spec.ts` and
`subscription-journeys.spec.ts`) locate controls by their demonstration labels,
such as "Back to account"; rewording owned copy requires updating those
locators. After extraction, these are application tests. If you keep the callback-free policy, narrow action lists, omit
`retention.pausePreset` or rewrite copy, adapt or replace the affected fixtures
and assertions in your application. Startup validation defines the configuration
contract.

`test/installation.test.ts` checks that installation writes the schedule from
the owned configuration and accepts valid customized waves.
`test/checkout-recovery-stage.test.ts` checks subject selection for explicit
stages and the historical hour rule for legacy payloads.

After reconciliation, apply the managed snapshots, install the target's exact
dependencies and run typechecking, build, application tests and startup checks.
Keep customized owned bytes outside the managed snapshots. Npm-only
applications have no starter-owned file migration.
