# OpenLup

OpenLup is a subscription-commerce platform for physical goods. It brings the
storefront, checkout, subscriptions, customer self-service, fulfillment,
communications, and the platform seams needed to adapt those capabilities to a
business.

## Status: development preview

This development preview does not constitute a framework release, adopter
distribution, package/image channel, or upgrade contract. A source preview may
be useful for evaluation, but it is not a substitute for a versioned release.
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

## Source preview integrity

The preview tree carries machine-readable inputs that let a checkout validate
its public policy from the materialized tree alone:

- [Public policy registry](config/openlup-policy-registry.json)
- [Public publication catalogue](config/openlup-publication-catalog.json)
- The source-release contract, `config/openlup-source-release-contract.json`

The contract is computed from the tree rather than carried by it: the source
repository derives every field of it and the export writes it into the
materialized tree, so the file above is present in a materialized preview and
absent from the repository the preview was produced from.

Run `npm run oss:published-tree -- --policy` inside a materialized source
preview. Before public activation the contract is deliberately marked
`local-fixture` and uses reserved `.invalid` coordinates; it is not a public
release receipt or a support promise.

The projected root manifest exposes a closed command inventory: `build`,
`build:public-reference`, `build:public-reference:client`,
`build:public-reference:prerender`, `build:public-reference:ssr`,
`check:dco-signoff`, `guard:client-secret-boundary`,
`guard:public-reference-site-routes`, `oss:published-tree`, and `test`. The
public workflow is the execution owner for that inventory; source-only deploy,
secret-management, smoke, and environment-specific operator commands are not exported.
The projected `npm test` command runs the same whole-directory public suite as
Published Tree CI, so a fresh consumer does not need a private test selector.

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
