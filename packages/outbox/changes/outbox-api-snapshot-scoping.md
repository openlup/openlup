- Scope `@openlup/outbox` `.api.md` declaration snapshots to each subpath's own exported declarations without changing any exported runtime or type symbol.

Migration: No application changes required. All `@openlup/outbox` public exports remain unchanged; only cross-subpath duplicate sections in generated `.api.md` snapshots were removed.
