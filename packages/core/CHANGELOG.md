# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

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

## [0.38.0]

- Publishable on the npm `latest` dist-tag as `0.38.0`, from tag
  `openlup-core-v0.38.0`.

Report bounded declaration and opt-in source scan coverage in `openlup-context` JSON, and show a notice when a scan reaches its file budget.

Migration: JSON consumers may receive an additive top-level `scans` array. Its conservative `limitReached` indicates the budget was reached, not that another eligible file exists; filters and other bounds still apply.

- Add opt-in `openlup-context mcp` stdio lookup for installed OpenLup context, with offline search and bounded installed-file reads. No kernel export or runtime dependency changes.

- Declare npm `keywords`, a `homepage` pointing at the package README in the
  source repository, and the issue tracker as `bugs`, so registry search and
  package pages lead to the documentation and to issue reports.

- Export `./package.json`, so tooling and agents can read the installed
  version and metadata with `import.meta.resolve("@openlup/core/package.json")` or
  a JSON import. It adds no code entry point.
