# Changelog

## [Unreleased]

## [0.41.0]

- Publishable on the npm `latest` dist-tag as `0.41.0`, from tag
  `openlup-outbox-v0.41.0`.

- Republish unchanged Outbox runtime, exports and SQL with the complete
  `0.41.0` package set and exact `@openlup/core@0.41.0` peer.

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
