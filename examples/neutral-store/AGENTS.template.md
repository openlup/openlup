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
- **A missing seam holds the dependent change.** Record a local reproducer and obtain authority
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

Prepare the selected artifacts and dependencies as described in the [starter guide](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/core/docs/guide/how-to/build/customize-the-starter.md).
For the local UI edit loop, run `npm run dev` and refresh the browser after a
successful build or host restart. See the [starter guide](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/core/docs/guide/how-to/build/customize-the-starter.md) for supported platforms
and limits. `npm run build` then `npm start` remains the ordinary one-shot preview.

| Task | Application-relative route | Existing verification route |
| --- | --- | --- |
| Brand, copy, media, offer or cadence | `owned/store.config.ts`, `owned/copy.ts`, `public/media/`; start at [customization](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/core/docs/guide/how-to/build/customize-the-starter.md) | `npm test`, `npm run typecheck`, `npm run build`; add new media to `ownership.json` |
| Product, offer or checkout presentation | The three functions in `owned/fragments.ts` | Typecheck and build, then relevant browser proof |
| Minimum-unit validation | Owned input, the shared `shared/offer.ts` validator and `test/offer.test.ts` | Relevant offer tests; preserve browser/host parity |
| New route or whole-page change | [Changes that need a page copy](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/core/docs/guide/how-to/build/customize-the-starter.md#change-a-page-or-add-a-route), `ownership.json` | Existing route tests and applicable bilingual browser proof; explain maintenance ownership |
| Unavailable action or integration error | `docs/limits.md`, `host/bindings.ts`, relevant composition and installed package contract | Follow the existing witness in [proof guidance](docs/proof.md); do not invent a success |

The configuration is one typed input, and `shared/offer.ts` is the single
application offer validator used by browser and host. Do not add a second
server-only or browser-only commercial rule. Public package engines still own
order, payment and subscription truth.

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
