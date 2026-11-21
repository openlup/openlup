For the next 1.x release. Adds `sql/0002_outbox_active_partial_indexes.sql` to
`@openlup/outbox` (registered in `sql/manifest.json`) with three partial indexes
scoped to active `public.outbox_events` rows (`pending`, `processing`, `failed`).

Migration: apply `sql/0002_outbox_active_partial_indexes.sql` after
`sql/0001_outbox.sql`. The migration is additive and idempotent
(`CREATE INDEX IF NOT EXISTS`).
