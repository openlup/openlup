- Scope `@openlup/outbox` `.api.md` declaration snapshots to each subpath's own exported declarations without changing any exported runtime or type symbol.

Migration: No application changes required. Snapshot scoping does not alter public exports. It removes cross-subpath duplicates from generated `.api.md` snapshots.
