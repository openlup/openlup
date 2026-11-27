# Changelog

## [Unreleased]

## [1.4.0]

- Publishable on the npm `latest` dist-tag as `1.4.0`, from tag
  `openlup-outbox-v1.4.0`.

- `composeIndependentHandlers` composes same-event destinations with separate durable receipts, bounded concurrency, deterministic outcomes and an explicit acknowledgement metadata projection.

Adds `sql/0002_outbox_active_partial_indexes.sql` to
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

