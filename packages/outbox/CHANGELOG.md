# Changelog

## [Unreleased]

## [0.40.0]

- Publishable on the npm `latest` dist-tag as `0.40.0`, from tag
  `openlup-outbox-v0.40.0`.

- Stop shipping `AGENT_CONTEXT.md`. Use core's `openlup-context` and the reader guide shipped in `@openlup/core`.

Skip payload compaction while an owner pins `metadata.retainPayload=true`, retaining unresolved downstream evidence without blocking unrelated terminal pruning. Removing the pin remains the obligation owner's responsibility.

## [0.39.0]

- Publishable on the npm `latest` dist-tag as `0.39.0`, from tag
  `openlup-outbox-v0.39.0`.

- Republish unchanged Outbox runtime, exports and SQL with the complete
  `0.39.0` package set and exact `@openlup/core@0.39.0` peer.

## [0.38.0]

- Publishable on the npm `latest` dist-tag as `0.38.0`, from tag
  `openlup-outbox-v0.38.0`.

- Declare npm `keywords`, a `homepage` pointing at the package README in the
  source repository, and the issue tracker as `bugs`, so registry search and
  package pages lead to the documentation and to issue reports.

- Export `./package.json`, so tooling and agents can read the installed
  version and metadata with `import.meta.resolve("@openlup/outbox/package.json")` or
  a JSON import. It adds no code entry point.
