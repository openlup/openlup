# Changelog

## [Unreleased]

## [0.38.0]

- Publishable on the npm `latest` dist-tag as `0.38.0`, from tag
  `openlup-outbox-v0.38.0`.

- Declare npm `keywords`, a `homepage` pointing at the package README in the
  source repository, and the issue tracker as `bugs`, so registry search and
  package pages lead to the documentation and to issue reports.

- Export `./package.json`, so tooling and agents can read the installed
  version and metadata with `import.meta.resolve("@openlup/outbox/package.json")` or
  a JSON import. It adds no code entry point.

## [0.37.0]

- Publishable on the npm `latest` dist-tag as `0.37.0`, from tag
  `openlup-outbox-v0.37.0`.

- Ship declaration maps that navigate to the packaged TypeScript sources,
  consumer-first installation guidance and release-tagged agent source citations.
- Allow Node `>=24` while
  retaining Node 24 for contributor verification. Pin exact package versions and
  upgrade the OpenLup set together.

- Republish unchanged Outbox runtime, exports and SQL with the complete
  `0.37.0` package set and exact `@openlup/core@0.37.0` peer. Core now recognizes
  the already-emitted settlement event; handler selection remains host-owned.

## [0.36.0]

- Publishable on the npm `latest` dist-tag as `0.36.0`, from tag
  `openlup-outbox-v0.36.0`.
