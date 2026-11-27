# Changelog

## [Unreleased]

## [1.4.0]

- Publishable on the npm `latest` dist-tag as `1.4.0`, from tag
  `openlup-outbox-v1.4.0`.

- `composeIndependentHandlers` composes same-event destinations with separate durable receipts, bounded concurrency, deterministic outcomes and an explicit acknowledgement metadata projection.

For the next 1.x release. Adds `sql/0002_outbox_active_partial_indexes.sql` to
`@openlup/outbox` (registered in `sql/manifest.json`) with three partial indexes
scoped to active `public.outbox_events` rows (`pending`, `processing`, `failed`).

Migration: apply `sql/0002_outbox_active_partial_indexes.sql` after
`sql/0001_outbox.sql`. The migration is additive and idempotent
(`CREATE INDEX IF NOT EXISTS`).

## [1.3.0]

- Publishable on the npm `latest` dist-tag as `1.3.0`, from tag
  `openlup-outbox-v1.3.0`.

- Scope `@openlup/outbox` `.api.md` declaration snapshots to each subpath's own exported declarations without changing any exported runtime or type symbol.

Migration: No application changes required. Snapshot scoping does not alter public exports. It removes cross-subpath duplicates from generated `.api.md` snapshots.

- Add optional `snoozeScope?: "all" | "event_type"` (`OutboxSnoozeScope`) on `OutboxDispatchConfig` so workers can isolate `{ kind: "snooze" }` circuit-breaking to the snoozed event type and affected aggregates without starving unrelated event types.

## [1.2.0]

- Publishable on the npm `latest` dist-tag as `1.2.0`, from tag
  `openlup-outbox-v1.2.0`.

## [1.1.0]

- Publishable on the npm `latest` dist-tag as `1.1.0`, from tag
  `openlup-outbox-v1.1.0`.

## [1.0.0]

- Publishable on the npm `latest` dist-tag as `1.0.0`, from tag
  `openlup-outbox-v1.0.0`.

Declare per-subpath stable, experimental and test-support policies for the coherent 1.0.0 package set. Stable APIs follow SemVer with open unions and literal sets; symbols tagged `@experimental` remain outside the stable promise. Consumer evidence is explicitly first-party.

Migration: keep a default branch for unknown union and literal-set values. Check the generated maturity table for experimental and test-support subpaths before upgrading. No runtime behavior or package export changes.
- Allow intentional API snapshot updates with a new or modified package change fragment; retain changed `CHANGELOG.md` as a legacy route. Fragment contents are validated during release preparation.

## [0.43.0]

- Publishable on the npm `latest` dist-tag as `0.43.0`, from tag
  `openlup-outbox-v0.43.0`.

- Republish unchanged Outbox runtime, exports and SQL with the complete `0.43.0`
  package set and exact `@openlup/core@0.43.0` peer.
