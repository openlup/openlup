# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.41.0]

- Publishable on the npm `latest` dist-tag as `0.41.0`, from tag
  `openlup-core-v0.41.0`.

- Republish unchanged Core runtime, exports and SQL with the complete `0.41.0`
  package set. The reader guide lists Platform's new `./payments/testing` subpath.

## [0.40.0]

- Publishable on the npm `latest` dist-tag as `0.40.0`, from tag
  `openlup-core-v0.40.0`.

- @openlup/core size growth: The reader guide now ships under `docs/guide/` and is measured by its own `pack.guide` cap; the code and root documentation classes are unchanged.

- Register the platform-owned ecommerce-export and checkout-qualification event vocabulary. This adds no executor or handler and activates no provider; the host selects disjoint claim allowlists explicitly.

- Ship the reader guide under `docs/guide/`; start with `docs/guide/README.md`.
- Search the installed reader guide, package `AGENTS.md`, `README.md`, declarations and exports with `openlup-context` and its MCP tools. Upgrade questions also search `CHANGELOG.md`.
- Stop shipping the package-root `AGENT_CONTEXT.md` corpus. Result and JSON output shapes are unchanged; a hit's optional `owner` field is no longer set.

## [0.39.0]

- Publishable on the npm `latest` dist-tag as `0.39.0`, from tag
  `openlup-core-v0.39.0`.

- Republish unchanged Core runtime, exports and SQL with the complete `0.39.0`
  package set.
