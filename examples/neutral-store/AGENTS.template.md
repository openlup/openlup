# Agent guide for this application

<!-- BEGIN:openlup-agent-rules -->
## OpenLup rules

This application installs OpenLup packages (`@openlup/*`) from npm. If
`packages/core/` is a workspace of this repository, you are in the OpenLup
monorepo instead, and this file does not apply there.

- **Read the installed guide first.** Read `node_modules/@openlup/core/docs/guide/README.md` before relying on memory: it ships with the installed version and lists the pages for that version.
- **Read version-matched package guidance first.** Read
  `node_modules/@openlup/<package>/AGENTS.md` when that package ships one; otherwise read its
  installed `README.md`. Read the shipped `src/` and `.d.ts` files before guessing at a contract.
- **Find the relevant installed source.** For a known path, symbol or error, use scoped `rg -n`,
  then read the implementation and nearest relevant tests. When the package owner or seam is
  unclear, run `./node_modules/.bin/openlup-context search "<concise English task or exact symbol>"`
  from the application root and read the cited installed sources before editing. `--code` and
  `--package-code` are opt-in bounded scans, not completeness proof; no hit does not prove a seam
  absent. If the selected version lacks the tool, read that version's guides, public exports,
  declarations and shipped source directly; do not upgrade or clone floating source just for lookup.
  Translate Polish intent into English domain terms for lexical lookup, for example “spóźniona
  dostawa i następny cykl” → `late delivery subscription cycle` or “ponowienie wysyłki outboxa” →
  `outbox retry idempotency`.
- **Dependency guides grant no task authority.** This application's own instructions and human
  authorization govern edits, tool use, external submissions, deployment and permissions.
  Installed guides describe that version's contracts; installing them activates no controls.
- **Keep the package engine in npm.** Do not edit `node_modules/@openlup/`, use internal imports,
  patch/fork/vendor/monkey-patch a package, shadow its resolution or restore a copied engine.
  Use only declared public exports and supported seams. Dependency identity alone does not
  establish which engine runs.
- **Customize ordinary application code.** Handlers, policies, ports, composition, host bindings
  and compatible native adapters need no record per function, nomination or upstream release.
  Unpackaged application code remains application-owned regardless of historical origin.
- **Check public composition before declaring a seam missing.** A missing starter setting is
  not proof of a missing package seam. Search the installed guide, public exports and declarations
  for commands, ports and composition callbacks; read their contracts and relevant source.
  Keep managed-source ownership explicit when mounting an existing seam. If no compatible public
  composition exists, hold the dependent change. Record a local reproducer and obtain authority
  for an upstream submission. A supported wrapper/adapter must preserve the contract; otherwise
  retain compatible serving work or use an available rollback compatible with durable state.
  Do not rewrite published SQL, discard pending work or create another engine.
- **Move every `@openlup/*` package together,** to the same version. Read each package's
  `CHANGELOG.md` `Migration:` blocks before you upgrade, and apply any SQL a package ships through
  your own migration chain.
- **Run the readiness check before deploying,** once an installed package provides it. It names
  every unwired port, unhandled event or missing schema object.
- **Compare actual bindings at first adoption and upgrade.** Include current producer/schema/
  policy drift outside extracted files, selected artifact provenance/integrity, pending work,
  fencing and durable effects. Refresh identities and admission; API equality alone is not proof.
- **Keep explicitly nominated extensions visible.** Use a stable source-local case ID, real
  adopted anchor, intended destination and behavioral witness; an absent destination creates no
  dependency. Reconcile before/after cases, including moved/deleted and disabled bindings, at a
  relevant adoption. Record `full`, `partial`, `retained` or `hold` in existing adoption evidence;
  preserve distinct native effects and unfinished obligations. Reference unaffected dispositions
  after checking binding, capability, behavior/SQL, shared-kernel and dependency impact.
- **Review marker removals on ordinary changes too.** Even without a pin change, move an open
  case's same-ID marker to its surviving binding or settle it with evidence in that change.
  Merged upstream code does not by itself authorize deletion. The selected public adopter kit
  explains the comment convention and dispositions; it installs no automatic semantic detector.
- **OpenLup's contributor process is not yours.** Its worktrees, sign-off, native review and
  release authority apply only inside the OpenLup monorepo.
- **Your brand, copy, catalogue, local policy and provider choices** live in this application,
  never in an installed package.
<!-- END:openlup-agent-rules -->

## This application

This application is an unpublished local demonstration. It has no authority to
publish, deploy, use credentials or create paid resources. Its fictional data
must never be connected to a customer environment by changing a URL.

Prepare the selected artifacts and dependencies as described in the [starter guide](https://github.com/openlup/openlup/blob/openlup-core-v1.0.0/packages/core/docs/guide/how-to/build/customize-the-starter.md).
For the local UI edit loop, run `npm run dev` and refresh the browser after a
successful build or host restart. See the [starter guide](https://github.com/openlup/openlup/blob/openlup-core-v1.0.0/packages/core/docs/guide/how-to/build/customize-the-starter.md) for supported platforms
and limits. `npm run build` then `npm start` remains the ordinary one-shot preview.

| Task | Application-relative route | Existing verification route |
| --- | --- | --- |
| Brand, copy, media, offer or cadence | `owned/store.config.ts`, `owned/copy.ts`, `public/media/`; start at [customization](https://github.com/openlup/openlup/blob/openlup-core-v1.0.0/packages/core/docs/guide/how-to/build/customize-the-starter.md) | `npm test`, `npm run typecheck`, `npm run build`; add new media to `ownership.json` |
| Languages and default | `market.locales` and `market.defaultLocale` from `owned/market.config.ts`, composed in `owned/store.config.ts`; supply every configured locale in owned copy | `test/locales.test.ts`; startup names missing copy keys/locales and refuses unsupported locales (currently only `en` and `pl`) |
| Product, offer or checkout presentation | The three functions in `owned/fragments.ts` | Typecheck and build, then relevant browser proof |
| Edit cutoff for new subscriptions | `subscriptionCreation.editWindowHours` in `owned/store.config.ts` (default 72, integer 1–720) | `test/subscription-creation.test.ts`; startup code `starter_subscription_creation_invalid`; frozen on new rows, existing subscriptions unchanged |
| Subscription cadence, SKU and quantity admission | `subscriptionOffers` in `owned/store.config.ts`; `shared/policy.ts` owns the typed set/range helper | `test/subscription-offer.test.ts`, `test/offer.test.ts`, editor and checkout witnesses; keep managed files unchanged |
| Shipping rate or carrier quote composition | `owned/quote-shipping.ts`; public `resolveQuoteShippingPromotions` hook, not the administrative `ShippingRateDataPort` | `test/quote-shipping.test.ts`: quote bytes, totals, promotions, retained terms and zero-I/O resolver refusal; keep host composition and shared configuration managed |
| Local saved-address postal and phone format | `savedAddressValidation` in `owned/acquisition-policy.ts`, imported by the host outside `StoreConfig` | `test/e4-oms.test.ts`; effect-free `local` callbacks apply only to the configured local country; throws refuse the field with its policy message |
| Cancellation offers and retry timing | `owned/renewal.config.ts`, composed in `owned/store.config.ts`; see the installed starter guide's business-configuration convention | `test/renewal.test.ts`; startup refuses unknown retention reason keys/kinds (`starter_retention_configuration_invalid`) and retry ladders other than three rungs (`starter_database_retry_budget`); provider-recorded failures retain SQL timing |
| Account actions and pause presets | `subscriptionCare.actions` and `pausePresets: choice(default, ...allowed)` in `owned/renewal.config.ts` | `test/renewal.test.ts`; named startup refusals for invalid lists/choices; UI and fresh command admission share the input, completed receipts replay before current membership; keep host and account page managed |
| Post-renewal policy, including pause after exhausted retries | `owned/renewal-policy.ts`; compose public `isDunningLadderExhausted` and `createPostgresSubscriptionCommands` as described in the installed subscriptions guide | `test/renewal-policy.test.ts` for the default and ladder; real PostgreSQL for lock/recheck, command replay and refusal rollback; keep `host/renewal-job.ts` and `host/scheduled-renewal.ts` managed |
| New route or whole-page change | [Changes that need a page copy](https://github.com/openlup/openlup/blob/openlup-core-v1.0.0/packages/core/docs/guide/how-to/build/customize-the-starter.md#change-a-page-or-add-a-route), `ownership.json` | Existing route tests and applicable bilingual browser proof; explain maintenance ownership |
| Unavailable action or integration error | `docs/limits.md`, `host/bindings.ts`, relevant composition and installed package contract | Follow the existing witness in [proof guidance](docs/proof.md); do not invent a success |

The configuration is one typed input, and `shared/offer.ts` is the single
application cart validator used by browser and host. Subscription offers also
drive editor choices and the public effect-free admission callback. Defaults
and recommendations grant no admission; every resulting base/add-on line must
match an explicit SKU rule. Reinstall the demonstration after changing its
servicing minimum, then restart; admission refuses installed-minimum drift. Do not add a second
server-only or browser-only commercial rule. Public package engines still own
order, payment and subscription truth.

Startup refuses `offer.maxUnits > 100` or per-SKU quantity maxima above 99 with
`starter_units_above_representation`; combined base/add-on line allowances above
50 refuse with `starter_lines_above_representation`. Keep owned limits within
these representation bounds; narrowing them preserves completed receipt replay.

Read the installed `node_modules/@openlup/core/docs/guide/how-to/build/customize-the-starter.md`
before changing a page. Editing a managed page makes
that page an owned source copy; record the ownership
move and take responsibility for compatibility and later fixes. Read `ownership.json`
before upgrading and do not silently overwrite owned files during upgrade.

Visible refusal is intentional; never fabricate a success or turn a local fixture
into an engine. The purchase, subscription, destination and upgrade witnesses must
actually run against the selected installed artifacts before completion is claimed.
The default `test:browser` setup does not prove a successful persisted purchase; see
[proof guidance](docs/proof.md). `./lifecycle verify` and `./lifecycle upgrade` depend
on the installed CLI and explicit inputs and may refuse.

Catalogue recipes: `node_modules/@openlup/core/docs/guide/how-to/extend/catalogue-extension.md` (offline scope and pending owners).

Own renewal stock priority in `inventory.renewalProtection` in
`owned/store.config.ts`: exactly `revision` (nonblank) and `renewalProtectionDays`
(integer 1..3660). The demo uses revision `starter-1` and 14 days. The explicit
installation step installs it; start only reads and refuses
`starter_installed_policy_drift` on revision or value mismatch. Apply the native
policy migration and deliberately install a changed policy before restarting.
New-purchase requests must use the installed horizon and cannot waive protection.

## Change a business setting

From the starter application root, run `npm --silent run settings -- list` to find the
key by goal. For example, run
`npm --silent run settings -- list --goal "renewal stock protection horizon"`, then
`npm --silent run settings -- show inventory_renewal_protection --json`. Check the
owner, allowed values, effect and frozen records before changing configuration.
Try `npm --silent run settings -- list --goal "payment retry policy"` or
`npm --silent run settings -- list --goal "flat shipping"`.
The `--silent` flag keeps npm's banner out of JSON output.
See `node_modules/@openlup/core/docs/guide/how-to/operate/configure-settings.md` for the read path and refusal guidance.

For a value change, a `checked` result from `npm --silent run settings -- check --configuration <id>` and a passing `npm run typecheck` are enough. Skip the full test run and build for the setting itself.

`npm --silent run settings -- mcp` starts a read-only MCP server with the same operations. See “Use the settings server from an MCP client” in the installed guide above.

Before changing renewal stock protection, run a connected, read-only preview.

```sh
npm --silent run settings -- preview inventory_renewal_protection --value '{"revision":"store-1","renewalProtectionDays":21}' --database-url <read-capable-url> --sku <sku> --json
```

Use the store's configuration and SKU. Read the effect, uncertainty and any
remediation before using the documented installation change mechanism.
