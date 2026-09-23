# OpenLup

OpenLup is a subscription-commerce platform for physical goods. It brings the
storefront, checkout, subscriptions, customer self-service, fulfillment,
communications, and the platform seams needed to adapt those capabilities to a
business.

## Status: development preview

This development preview does not constitute a stable framework release,
supported adopter distribution, package/image channel, or upgrade contract.
An immutable [source preview release](https://github.com/openlup/openlup/releases)
can be used for bounded evaluation; it is not a supported full-platform install.
Claims of framework stability wait for the separate `P1-SF` gate: a release/BOM, thin
adopter application, public extension and conformance contracts, upgrade tools,
and passing public installation, build, test, compatibility, provenance, and
independent-adopter evidence.

The intended topology is one platform monorepo plus separately owned adopter
applications. Adopters keep their own brand, content, catalogue, local policy,
and integrations; platform code remains generic and evolves upstream.

## Platform documentation

- [Platform documentation index](docs/platform/README.md)
- [Public agent guide](docs/platform/AGENT_GUIDE.md)
- [Architecture and extension boundaries](docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
- [Data and migration contract](docs/platform/DATA_AND_MIGRATIONS.md)
- [Runtime and self-hosting boundary](docs/platform/RUNTIME_AND_SELF_HOSTING.md)
- [Canonical status, idempotency, and provider contracts](docs/platform/CANONICAL_CONTRACTS.md)

## Evaluate the public reference

Choose an immutable tag from the [OpenLup releases](https://github.com/openlup/openlup/releases)
and review its release-specific upgrade notes before changing a pinned checkout.
For example, `openlup-source-preview/4` was the latest release at the
2026-09-23 documentation review. From a fresh public checkout at that tag, use
Node and npm versions recorded in [.nvmrc](.nvmrc) and `package.json`:

```sh
npm ci
npm run oss:published-tree -- --policy
npm run oss:published-tree -- --inventory
npm run oss:published-tree -- --typecheck
npm test
npm run build
```

By default, the [capability manifest](config/public-reference-capability-manifest.json)
declares only catalogue/item pages (`/`, `/items/field-notes`) and `/healthz`,
with GET/HEAD methods. The reference refuses checkout, subscription, admin,
API/BFF, cron and mutations. The build and checks do not start a database,
payment provider or full subscription application. For the actual support
boundary, see the [install support policy](.github/INSTALL_SUPPORT_POLICY.md).
Contributions use [CONTRIBUTING.md](CONTRIBUTING.md); a released source preview
does not itself update any adopter.

Source revisions containing the [disposable subscription profile](docs/platform/SUBSCRIPTION_REFERENCE.md)
also provide an explicit Node + local Supabase evaluation: one recurring product,
captured payment, confirmed email sign-in, own account and renewal-date change.
This profile is opt-in, creates its own disposable database, and requires no
adopter repository. Consult the selected immutable release notes for availability;
the older static-only previews do not gain it automatically.

## Source preview integrity

The preview tree carries machine-readable inputs that let a checkout validate
its public policy from the materialized tree alone:

- [Public policy registry](config/openlup-policy-registry.json)
- [Public publication catalogue](config/openlup-publication-catalog.json)
- The source-release contract, `config/openlup-source-release-contract.json`

The source-release contract was computed during the one-time public-root
materialization and is now present in this public tree. It binds the declared
inventory and policy inputs; it is not itself a release receipt or support
promise. The [publication completeness policy](.github/PUBLICATION_COMPLETENESS.md)
explains the historical derivation and the public-only checks used after activation.

Run `npm run oss:published-tree -- --policy` from the public repository root.
The contract is an activation-candidate source contract, not an immutable
preview receipt or a support promise.

The projected root manifest exposes a closed command inventory: `build`,
`build:public-reference`, `build:public-reference:client`,
`build:public-reference:prerender`, `build:public-reference:ssr`,
`check:dco-signoff`, `guard:client-secret-boundary`,
`guard:public-reference-site-routes`, `oss:published-tree`, and `test`. The
public workflow is the execution owner for that inventory; source-only deploy,
secret-management, smoke, and environment-specific operator commands are not exported.
The root `npm test` command runs the same selected public suite as Published
Tree CI. The standalone `packages/core` package tests are not collected by
that root Vitest configuration; see [CONTRIBUTING.md](CONTRIBUTING.md#development-preview-checks)
for the separate package command and its explicit public CI execution.

## Project references

- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution and DCO rules.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — community conduct.
- [SECURITY.md](SECURITY.md) — responsible disclosure and sensitive-material
  handling.
- [LICENSE](LICENSE) — Apache License 2.0.
- [.github/GOVERNANCE.md](.github/GOVERNANCE.md) — contribution admission and
  ownership policy.
- [.github/INSTALL_SUPPORT_POLICY.md](.github/INSTALL_SUPPORT_POLICY.md) —
  current evaluation and reproduction limits.
- [.github/PUBLICATION_COMPLETENESS.md](.github/PUBLICATION_COMPLETENESS.md) —
  publication evidence boundary.
