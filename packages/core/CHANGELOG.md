# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

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

## [0.37.0]

- Publishable on the npm `latest` dist-tag as `0.37.0`, from tag
  `openlup-core-v0.37.0`.

- Ship declaration maps that navigate to the packaged TypeScript sources,
  consumer-first installation guidance and release-tagged agent source citations.
- Allow Node `>=24` while
  retaining Node 24 for contributor verification. Pin exact package versions and
  upgrade the OpenLup set together.
- The tool-only installed context lookup accepts release citations only for its
  own package and installed version, and deduplicates shared canonical owners
  across the matching package set without fetching links.

- Recognize `commerce.settlement.settled`, already emitted by the platform settlement rail, in `PLATFORM_EVENT_VOCABULARY`. A known settlement fact without a registered consumer can remain pending without blocking a later paid receipt on the same order aggregate. This adds no handler, acknowledgement, delivery or SQL seed.

Migration:

Hosts using the complete vocabulary for readiness must supply an explicit owned `ignored` or `dormant` exemption for this type when they select no consumer. The claim allowlist still derives from handlers; readiness refusal for an unhandled, unexempted type is unchanged. No schema, grant or package-version change is needed in this source fix.
